-- Auto-handoff support: track local Claude process and last matrix activity.
-- See docs/AUTO_HANDOFF.md for the state machine and recovery flow.

ALTER TABLE sessions ADD COLUMN local_pid INTEGER;
ALTER TABLE sessions ADD COLUMN last_matrix_activity TEXT;

-- The 'local_active' status means a local terminal session holds this
-- Claude session; the supervisor is passive until the local claude exits
-- or a new Matrix message arrives. No schema change needed for status
-- itself (TEXT column), only TypeScript type updates.
