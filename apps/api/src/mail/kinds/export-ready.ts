import { Type } from '@feathersjs/typebox'
import { defineMailKind } from '../kind.js'

// The skeleton's notification (ADR 0013, 0027): a GDPR export is ready. The
// worker sends it in the transaction that marks the export ready, to the
// account that asked for it, the only one that may fetch it.
export const exportReady = defineMailKind({
  key: 'gdpr.export-ready',
  type: 'notification',
  params: Type.Object({ exportId: Type.String({ format: 'uuid' }) }, { additionalProperties: false }),
  variables: Type.Object(
    {
      // When it was asked for.
      requestedAt: Type.String({ format: 'date-time' }),
      // An export of the recipient themselves, fetched from their profile;
      // otherwise one an admin asked for, fetched from the data requests page.
      ownData: Type.Boolean()
    },
    { additionalProperties: false }
  ),
  build: async (db, userId, { exportId }) => {
    const row = await db('dataExports')
      .where({ id: exportId, requestedBy: userId, state: 'ready' })
      .first<{ subjectId: string; createdAt: Date } | undefined>('subjectId', 'createdAt')
    // Gone (expired, erased) or not ready: nothing to tell.
    if (!row) return null
    return { requestedAt: row.createdAt.toISOString(), ownData: row.subjectId === userId }
  },
  sample: { requestedAt: '2026-09-28T09:30:00.000Z', ownData: true },
  defaults: {
    de: {
      subject: 'Ihr Datenexport ist bereit',
      body: `Hallo {{ recipient.givenName }} {{ recipient.surname }},

der Datenexport, den Sie am {{ requestedAt | datetime }} angefordert haben, steht zum Herunterladen bereit.

{% if ownData %}[Zum Export in Ihrem Profil]({{ app.url }}/profile){% else %}[Zum Export unter Datenanfragen]({{ app.url }}/gdpr){% endif %}

Der Export wird nach einigen Tagen automatisch gelöscht.`
    },
    en: {
      subject: 'Your data export is ready',
      body: `Hello {{ recipient.givenName }} {{ recipient.surname }},

the data export you requested on {{ requestedAt | datetime }} is ready to download.

{% if ownData %}[Go to the export in your profile]({{ app.url }}/profile){% else %}[Go to the export under data requests]({{ app.url }}/gdpr){% endif %}

The export is deleted automatically after a few days.`
    }
  }
})
