# 0002: S3 object storage

- Status: Accepted
- Date: 2026-09-14

## Context

S3 object storage is needed to store uploaded documents / files. This project is a template for our feature de-facto standard implementation of our web services.
It is reasonable to assume that for the forseeable future we won't have more than 50 concurrent users on our systems.
Therefore we will spin up S3 as a local dependency of our deployments.

## Decision

Object storage is part of the deployment model for upload or export features.

## Consequences

- Upload and export flows have a scalable storage backend.
- Bucket naming, endpoint configuration, and permission boundaries remain environment-driven and explicit.
