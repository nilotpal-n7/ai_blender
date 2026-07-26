// Package queue provides an abstraction over the Redis-backed job queue
// used to dispatch work to Blender cloud workers.
//
// TODO: Implement the following:
//   - EnqueueJob(ctx, jobType, payload) — push a job onto the blender:jobs queue
//   - DequeueJob(ctx) — pop a job (used by the Python worker, not this service)
//   - GetJobStatus(ctx, jobID) — check job completion/failure status
//   - NewClient(cfg) — initialize a Redis connection pool
//
// The job queue uses Redis Streams (XADD/XREADGROUP) for reliable,
// consumer-group-based job distribution to multiple Blender workers.
package queue
