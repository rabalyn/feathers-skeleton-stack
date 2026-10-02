import { Type, type Static } from '@feathersjs/typebox'

// The response to data or a query a schema refused (ADR 0005, 0018): a 400
// that names the fields, never the rule, the pattern or the allowed values
// (decided 2026-10-02). A stable contract, exported to the client as a type;
// the frontend may attach a message to each field it names.
export const validationErrorSchema = Type.Object(
  {
    name: Type.Literal('BadRequest'),
    message: Type.Literal('Invalid data'),
    code: Type.Literal(400),
    className: Type.Literal('bad-request'),
    data: Type.Object({}, { additionalProperties: false }),
    // `title`, `ownerId` (not accepted), `$select.0`: the field's path,
    // dot-separated.
    errors: Type.Array(Type.Object({ field: Type.String() }, { additionalProperties: false }))
  },
  { $id: 'ValidationError', additionalProperties: false }
)
export type ValidationError = Static<typeof validationErrorSchema>
