const ROLLING_PACE_DAYS = 30;

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function formatDateTime(dateStr) {
  const dt = new Date(dateStr);
  return isValidDate(dt) ? dt.toLocaleString() : '';
}

export function formatDate(dateStr) {
  const dt = new Date(dateStr);
  return isValidDate(dt) ? dt.toLocaleDateString() : '';
}

export function parseLocalDateString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ) {
      date.setHours(0, 0, 0, 0);
      return date;
    }
    return null;
  }
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(trimmed)) return null;

  const fallback = new Date(trimmed);
  if (isValidDate(fallback)) {
    const date = new Date(
      fallback.getFullYear(),
      fallback.getMonth(),
      fallback.getDate()
    );
    date.setHours(0, 0, 0, 0);
    return date;
  }
  return null;
}

export function formatLocalDateString(date) {
  if (!isValidDate(date)) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addLocalDays(date, days) {
  if (!isValidDate(date)) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfLocalDay(date) {
  if (!isValidDate(date)) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function minDate(a, b) {
  if (!isValidDate(a)) return isValidDate(b) ? new Date(b) : null;
  if (!isValidDate(b)) return new Date(a);
  return a <= b ? new Date(a) : new Date(b);
}

export function maxDate(a, b) {
  if (!isValidDate(a)) return isValidDate(b) ? new Date(b) : null;
  if (!isValidDate(b)) return new Date(a);
  return a >= b ? new Date(a) : new Date(b);
}

export function sumEntryHours(
  entries,
  startInclusive = null,
  endExclusive = null
) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  let totalSeconds = 0;
  entries.forEach((entry) => {
    if (!entry || !entry.duration) return;
    const start = new Date(entry.startTime);
    if (!isValidDate(start)) return;
    if (startInclusive && start < startInclusive) return;
    if (endExclusive && start >= endExclusive) return;
    totalSeconds += entry.duration || 0;
  });
  return totalSeconds / 3600;
}

export function countWorkdays(startDate, endDate) {
  const start = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate()
  );
  const end = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate()
  );
  if (end <= start) return 0;
  let count = 0;
  let current = new Date(start);
  while (current < end) {
    const day = current.getDay();
    if (day >= 1 && day <= 5) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

export function getProjectStartDate(project) {
  const start = parseLocalDateString(project.startDate || project.createdAt);
  if (start) return start;
  return new Date(project.createdAt || Date.now());
}

export function getProjectDeadlineDay(project) {
  if (!project) return null;
  const hasDeadline =
    project.deadline != null && String(project.deadline).trim() !== '';
  if (!hasDeadline) return null;
  return parseLocalDateString(String(project.deadline));
}

export function getProjectDeadlineEndExclusive(project) {
  const deadlineDay = getProjectDeadlineDay(project);
  if (!deadlineDay) return null;
  return addLocalDays(deadlineDay, 1);
}

export function isProjectActive(project, referenceDate = new Date()) {
  const startDate = getProjectStartDate(project);
  const hasDeadline =
    project.deadline != null && String(project.deadline).trim() !== '';
  if (!hasDeadline) {
    return startDate <= referenceDate;
  }
  const deadlineEndExclusive = getProjectDeadlineEndExclusive(project);
  if (!isValidDate(deadlineEndExclusive)) {
    return startDate <= referenceDate;
  }
  return startDate <= referenceDate && referenceDate < deadlineEndExclusive;
}

export function getRollingWindowBounds(
  referenceDate = new Date(),
  days = ROLLING_PACE_DAYS
) {
  const endExclusive = addLocalDays(startOfLocalDay(referenceDate), 1);
  const start = addLocalDays(endExclusive, -Math.max(1, days));
  return { start, endExclusive };
}

export function getProjectPlanningSnapshot(project, entries, snapshotDate) {
  const deadlineEndExclusive = getProjectDeadlineEndExclusive(project);
  const projectStart = getProjectStartDate(project);
  const snapshotStart = maxDate(startOfLocalDay(snapshotDate), projectStart);
  if (
    !deadlineEndExclusive ||
    !snapshotStart ||
    snapshotStart >= deadlineEndExclusive
  ) {
    return {
      snapshotStart,
      remainingHours: 0,
      remainingWorkdays: 0,
      dailyRate: 0
    };
  }
  const workedBeforeSnapshot = sumEntryHours(entries, null, snapshotStart);
  const remainingHours = Math.max(
    0,
    (project.budgetHours || 0) - workedBeforeSnapshot
  );
  const remainingWorkdays = countWorkdays(snapshotStart, deadlineEndExclusive);
  if (remainingHours <= 0 || remainingWorkdays <= 0) {
    return {
      snapshotStart,
      remainingHours,
      remainingWorkdays,
      dailyRate: 0
    };
  }
  return {
    snapshotStart,
    remainingHours,
    remainingWorkdays,
    dailyRate: remainingHours / remainingWorkdays
  };
}

export function getProjectPlannedHoursForPeriod(
  project,
  entries,
  snapshotDate,
  periodEndExclusive
) {
  const deadlineEndExclusive = getProjectDeadlineEndExclusive(project);
  const snapshot = getProjectPlanningSnapshot(project, entries, snapshotDate);
  if (
    !deadlineEndExclusive ||
    !snapshot.snapshotStart ||
    snapshot.dailyRate <= 0 ||
    !periodEndExclusive
  ) {
    return 0;
  }
  const effectiveEnd = minDate(periodEndExclusive, deadlineEndExclusive);
  if (!effectiveEnd || effectiveEnd <= snapshot.snapshotStart) return 0;
  const workdaysInPeriod = countWorkdays(snapshot.snapshotStart, effectiveEnd);
  if (workdaysInPeriod <= 0) return 0;
  return snapshot.dailyRate * workdaysInPeriod;
}

export function utcDayNumber(date) {
  if (!isValidDate(date)) return NaN;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / msPerDay
  );
}

export function diffCalendarDays(startDay, endDay) {
  const startNum = utcDayNumber(startDay);
  const endNum = utcDayNumber(endDay);
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return 0;
  return endNum - startNum;
}

export function clampUnitInterval(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function formatCurrency(num, decimals = 1) {
  if (!isFinite(num)) return '';
  let rounded;
  if (decimals >= 0) {
    const factor = Math.pow(10, decimals);
    rounded = Math.round(num * factor) / factor;
    return rounded.toFixed(decimals) + ' kr';
  }
  const factor = Math.pow(10, -decimals);
  rounded = Math.round(num / factor) * factor;
  return Math.round(rounded).toString() + ' kr';
}

export function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (!isValidDate(date)) return '';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return date.toLocaleString();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}
