# claude-feathers

FeathersJS and Vue/Quasar application with PostgreSQL, PgBouncer, and rootless Podman deployment.

## Status

The repository is currently in the architecture and setup phase. The proposed stack and deployment model are documented in [docs/technical-architecture.md](docs/technical-architecture.md).

## Planned Stack

- FeathersJS API
- PostgreSQL behind PgBouncer
- Vue 3, Quasar, and `feathers-pinia`
- pnpm workspace for the API, web app, and future shared packages
- Nginx reverse proxy for production-like local and CI testing
- Rootless Podman for the containerized stack
- Dedicated local stack log viewer

## Documentation

- [Technical architecture](docs/technical-architecture.md): current system design, container topology, testing approach, and documentation convention
- `docs/adr/`: architecture decision records for choices with meaningful alternatives
