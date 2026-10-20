// api/attendance.js — shared rule for rostered shifts that were never worked.
// Used by the poll (recent shifts) and by one-off history recalculation, so both
// count the same way.

// Deputy leave Status: 0 awaiting approval, 1 approved, 2 declined, 3 cancelled.
// Pending or approved leave means the day was marked off.
const leaveCounts = (status) => status !== 2 && status !== 3;
const overlaps = (a, b) => a.start < b.end && a.end > b.start;

/**
 * A shift is "no clock-in" when it has ended, Deputy did not match a timesheet
 * to it, no timesheet overlaps it, and no (non-declined) leave overlaps it.
 * All times are ms.
 *   shifts:     [{ start, end, matched }]   (matched = Deputy MatchedByTimesheet set)
 *   timesheets: [{ start, end }]            (end = now for an in-progress timesheet)
 *   leave:      [{ start, end, status }]
 */
function findMissedShifts({ shifts, timesheets = [], leave = [], now = Date.now() }) {
  return shifts.filter(s => s.end <= now
    && !s.matched
    && !timesheets.some(t => overlaps(t, s))
    && !leave.some(l => leaveCounts(l.status) && overlaps(l, s)));
}

// Deputy API rows → the shapes above (Deputy times are unix seconds).
const toShift = (r) => ({ start: r.StartTime * 1000, end: (r.EndTime || r.StartTime) * 1000, matched: !!r.MatchedByTimesheet });
const toTimesheet = (t, now = Date.now()) => ({ start: t.StartTime * 1000, end: t.EndTime && !t.IsInProgress ? t.EndTime * 1000 : now });
const toLeave = (l) => ({ start: l.Start * 1000, end: l.End * 1000, status: l.Status });

// Calendar date (YYYY-MM-DD) of a shift start in DISPLAY_TZ, so a shift is filed
// under the day (and month) the reports show it on.
const shiftDate = (ms, tz = process.env.DISPLAY_TZ || 'America/Los_Angeles') =>
  new Date(ms).toLocaleDateString('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });

module.exports = { findMissedShifts, toShift, toTimesheet, toLeave, shiftDate };
