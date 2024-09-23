import { DurableObject } from 'cloudflare:workers';
export class SeatBooking extends DurableObject {
	private seats: Map<string, boolean> = new Map();

	sql = this.ctx.storage.sql;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.initializeSeats();
	}

	private initializeSeats() {
		const cursor = this.sql.exec(`PRAGMA table_list`);

		// Check if a table exists.
		if ([...cursor][0].name === 'seats') {
			console.log('Table already exists');
			return;
		}

		this.sql.exec(`
				  CREATE TABLE IF NOT EXISTS seats (
					seatId TEXT PRIMARY KEY,
					occupant TEXT
				  )
				`);

		// For this demo, we populate the table with 60 seats.
		for (let row = 1; row <= 10; row++) {
			for (let col = 0; col < 6; col++) {
				const seatNumber = `${row}${String.fromCharCode(65 + col)}`;
				this.sql.exec(`INSERT INTO seats VALUES (?, null)`, seatNumber);
			}
		}
	}

	// Assign passenger to a seat.
	assignSeat(seatId: string, occupant: string) {
		// Check that seat isn't occupied.
		let cursor = this.sql.exec(`SELECT occupant FROM seats WHERE seatId = ?`, seatId);
		let result = [...cursor][0]; // Get the first result from the cursor.

		if (!result) {
			return new Response('Seat not available', { status: 400 });
		}
		if (result.occupant !== null) {
			return new Response('Seat not available', { status: 400 });
		}

		// If the occupant is already in a different seat, remove them.
		this.sql.exec(`UPDATE seats SET occupant = null WHERE occupant = ?`, occupant);

		// Assign the seat. Note: We don't have to worry that a concurrent request may
		// have grabbed the seat between the two queries, because the code is synchronous
		// (no `await`s) and the database is private to this Durable Object. Nothing else
		// could have changed since we checked that the seat was available earlier!
		this.sql.exec(`UPDATE seats SET occupant = ? WHERE seatId = ?`, occupant, seatId);

		// Broadcast the updated seats.
		this.broadcastSeats();
		return new Response(`Seat ${seatId} booked successfully`);
	}

	// Get all seats.
	private getSeats() {
		let results = [];

		// Query returns a cursor.
		let cursor = this.sql.exec(`SELECT seatId, occupant FROM seats`);

		// Cursors are iterable.
		for (let row of cursor) {
			// Each row is an object with a property for each column.
			results.push({ seatNumber: row.seatId, occupant: row.occupant });
		}

		return JSON.stringify(results);
	}

	private handleWebSocket(request: Request) {
		console.log('WebSocket connection requested');
		const [client, server] = Object.values(new WebSocketPair());

		this.ctx.acceptWebSocket(server);
		console.log('WebSocket connection established');
		console.log(this.ctx.getWebSockets);

		return new Response(null, { status: 101, webSocket: client });
	}

	private broadcastSeats() {
		this.ctx.getWebSockets().forEach((ws) => ws.send(this.getSeats()));
	}

	async fetch(request: Request) {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/seats') {
			return new Response(JSON.stringify(this.getSeats()), { headers: { 'Content-Type': 'application/json' } });
		} else if (request.method === 'POST' && url.pathname === '/book-seat') {
			const { seatNumber, name } = (await request.json()) as { seatNumber: string; name: string };
			return this.assignSeat(seatNumber, name);
		} else if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocket(request);
		}

		return new Response('Not found', { status: 404 });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Get flight id from the query parameter
		const url = new URL(request.url);
		const flightId = url.searchParams.get('flightId');

		if (!flightId) {
			return new Response('Flight ID not found', { status: 404 });
		}

		const id = env.SEAT_BOOKING.idFromName(flightId);
		const stub = env.SEAT_BOOKING.get(id);
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;
