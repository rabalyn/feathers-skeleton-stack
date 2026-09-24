# 0001: Include Valkey in the deployment

- Status: Accepted
- Date: 2026-09-14

## Context

Valkey is as a required dependency for shared authentication rate-limit state from the initial deployment. It is also described as a production private-network dependency.

## Decision

Valkey is a required service for the deployment. It remains part of the backend private network and is used for shared authentication rate-limit state, not for business data persistence.

## Consequences

- Valkey is a dependency for local development, for testing and for production deployments.
- Authentication rate limiting is consistent across API instances and can be shared by multiple app processes.
- The production topology stays aligned with the authentication design and the backend network model.
- The deployment must include Valkey health checks and the same service-level assumptions reflected in the API configuration.
