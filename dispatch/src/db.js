import pg from 'pg';

// Thin wrapper: every call is one of the *_svc database functions, so all
// dispatch rules stay in SQL and each call is a single transaction.
export function createDb(databaseUrl, poolOptions = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, ...poolOptions });

  async function call(fn, args = []) {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(`select * from public.${fn}(${placeholders})`, args);
    return rows;
  }
  async function scalar(fn, args) {
    const rows = await call(fn, args);
    return rows[0]?.[fn] ?? null;
  }
  // Functions returning a single composite give one all-null row when empty
  async function record(fn, args) {
    const rows = await call(fn, args);
    return rows[0] && rows[0].id ? rows[0] : null;
  }

  return {
    pool,
    end: () => pool.end(),
    claimMessage: (wamid) => scalar('claim_message_svc', [wamid]),
    createRide: (phone, transcript, dest) => record('create_ride_svc', [phone, transcript, dest]),
    setDestination: (rideId, dest) => record('set_destination_svc', [rideId, dest]),
    awaitingRide: (phone) => record('awaiting_ride_svc', [phone]),
    openRide: (phone) => record('open_ride_svc', [phone]),
    startSearch: (rideId, lat, lng) => call('start_search_svc', [rideId, lat, lng]),
    acceptRide: (rideId, driverId) => scalar('accept_ride_svc', [rideId, driverId]),
    declineRide: (rideId, driverId) => scalar('decline_ride_svc', [rideId, driverId]),
    completeRide: (rideId, driverId) => scalar('complete_ride_svc', [rideId, driverId]),
    cancelByToken: (token) => scalar('cancel_ride_by_token_svc', [token]),
    expireDue: () => call('expire_due_rides_svc'),
    setNotifyWamid: (rideId, wamid) => call('set_notify_wamid_svc', [rideId, wamid]),
    markNotifyRead: (wamid) => call('mark_notify_read_svc', [wamid]),
    claimFallbackCalls: () => call('claim_fallback_calls_svc'),
    driverByUser: (userId) => record('driver_by_user_svc', [userId]),
    rideStatusByToken: (token) => scalar('ride_status_by_token', [token]),
    pushTokens: async (driverIds) => {
      if (!driverIds?.length) return [];
      const { rows } = await pool.query(
        'select id, push_token from public.drivers where id = any($1::uuid[]) and push_token is not null',
        [driverIds]);
      return rows;
    },
  };
}
