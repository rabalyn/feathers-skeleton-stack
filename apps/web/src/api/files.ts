import { DATA_EXPORT_CONTENTS_URL, FILE_CONTENTS_URL, FILENAME_HEADER, FILES_URL, type File as StoredFile } from '@app/api/client'
import { client } from '@/api/feathers'

// Uploads and downloads are plain HTTP, since the body is the file
// (ADR 0020). The access token lives in the Feathers client's memory only
// (ADR 0014), so each request carries it by hand; nothing here can be an
// <img src> or a link to the API.

// Shaped like a Feathers error, so useNotify reads it the same way.
export class FileRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

const authorization = async () => {
  const token = await client.authentication.getAccessToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

const failed = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as { message?: string; data?: unknown }
  return new FileRequestError(response.status, body.message ?? response.statusText, body.data)
}

export const uploadFile = async (file: File): Promise<StoredFile> => {
  const response = await fetch(FILES_URL, {
    method: 'POST',
    headers: {
      ...(await authorization()),
      'content-type': file.type,
      [FILENAME_HEADER]: encodeURIComponent(file.name)
    },
    body: file
  })
  if (!response.ok) throw await failed(response)
  return (await response.json()) as StoredFile
}

const fetchBlob = async (url: string): Promise<Blob> => {
  const response = await fetch(url, { headers: await authorization() })
  if (!response.ok) throw await failed(response)
  return response.blob()
}

export const fetchFile = (id: string): Promise<Blob> => fetchBlob(`${FILE_CONTENTS_URL}/${id}`)

const save = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

// Saves the file under its original name, as the server's attachment
// disposition would have.
export const downloadFile = async (id: string, filename: string) => save(await fetchFile(id), filename)

// A ready GDPR export, as the ZIP the server names (ADR 0013).
export const downloadExport = async (id: string, createdAt: string) =>
  save(await fetchBlob(`${DATA_EXPORT_CONTENTS_URL}/${id}`), `data-export-${createdAt.slice(0, 10)}.zip`)
