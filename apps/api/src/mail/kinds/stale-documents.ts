import { Type } from '@feathersjs/typebox'
import type { Knex } from 'knex'
import { defineMailKind } from '../kind.js'

// The skeleton's example campaign (ADR 0027), on the example documents: a
// reminder to everyone who owns documents nobody changed for a while,
// listing them. A product replaces it with its own, in the same shape: the
// admin's choices as parameters, a list per recipient built at send time.

const staleSince = (db: Knex, olderThanDays: number) => db.raw('now() - make_interval(days => ?)', [olderThanDays])

export const staleDocuments = defineMailKind({
  key: 'documents.stale-reminder',
  type: 'campaign',
  params: Type.Object(
    { olderThanDays: Type.Integer({ minimum: 1, maximum: 3650, default: 365 }) },
    { additionalProperties: false }
  ),
  variables: Type.Object(
    {
      olderThanDays: Type.Integer(),
      documents: Type.Array(
        Type.Object(
          { title: Type.String(), updatedAt: Type.String({ format: 'date-time' }) },
          { additionalProperties: false }
        )
      )
    },
    { additionalProperties: false }
  ),
  recipients: (db, { olderThanDays }) =>
    db('documents').distinct({ id: 'ownerId' }).where('updatedAt', '<', staleSince(db, olderThanDays)),
  build: async (db, userId, { olderThanDays }) => {
    const documents = await db('documents')
      .where({ ownerId: userId })
      .where('updatedAt', '<', staleSince(db, olderThanDays))
      .orderBy('updatedAt')
      .select<{ title: string; updatedAt: Date }[]>('title', 'updatedAt')
    // Changed since the campaign was sent: nothing to remind of.
    if (documents.length === 0) return null
    return {
      olderThanDays,
      documents: documents.map((row) => ({ title: row.title, updatedAt: row.updatedAt.toISOString() }))
    }
  },
  sample: {
    olderThanDays: 365,
    documents: [
      { title: 'Antrag Laborausstattung', updatedAt: '2025-03-14T10:00:00.000Z' },
      { title: 'Protokoll Kick-off', updatedAt: '2025-06-02T08:15:00.000Z' }
    ]
  },
  defaults: {
    de: {
      subject: 'Ihre Dokumente wurden länger nicht bearbeitet',
      body: `Hallo {{ recipient.givenName }} {{ recipient.surname }},

{% if documents.size == 1 %}dieses Dokument wurde{% else %}diese {{ documents.size }} Dokumente wurden{% endif %} seit über {{ olderThanDays | number }} Tagen nicht geändert:

{% for document in documents %}- {{ document.title }}, zuletzt geändert am {{ document.updatedAt | date }}
{% endfor %}
Bitte prüfen Sie, ob Sie sie noch brauchen: [Zu Ihren Dokumenten]({{ app.url }}/documents)`
    },
    en: {
      subject: 'Your documents have not been changed for a while',
      body: `Hello {{ recipient.givenName }} {{ recipient.surname }},

{% if documents.size == 1 %}this document has{% else %}these {{ documents.size }} documents have{% endif %} not been changed for more than {{ olderThanDays | number }} days:

{% for document in documents %}- {{ document.title }}, last changed on {{ document.updatedAt | date }}
{% endfor %}
Please check whether you still need them: [Go to your documents]({{ app.url }}/documents)`
    }
  }
})
