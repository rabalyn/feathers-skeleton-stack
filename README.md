# claude-feathers

Skeleton for FeathersJS and Vue/Quasar applications: a common infrastructure base that future products build on.

## Status

The repository is in the architecture phase. The architecture is defined by the decision records in [docs/adr_v2/](docs/adr_v2/README.md); start with its README. There is no separate architecture document, so the ADRs are the only source of truth.

## Building a product on it

A product is a clone of this repository with its history, under a remote of its own, merging the skeleton's tagged versions ([ADR 0035](docs/adr_v2/0035-products-derived-from-the-skeleton.md)). It names itself in [`product.env`](product.env): the project name, the display name and the local ports, so that several products' stacks run side by side.

## Documentation

- [docs/adr_v2/](docs/adr_v2/README.md): current architecture decision records
- `docs/adr/`: superseded v1 records, kept for history only
