// Thin client for the local FastAPI backend. All requests go to the same origin (/api),
// proxied by Vite in development and by nginx in Docker. No API keys live here.

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export const MAX_UPLOAD_MB = 20
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export type Duration = 3 | 5 | 8
export type AspectRatio = '9:16' | '16:9' | '1:1'
export type Motion = 'low' | 'medium' | 'high'
export type ProviderChoice = 'auto' | 'comfyui' | 'mock'

export interface UploadResult {
  file_id: string
  width: number
  height: number
  size_bytes: number
}

export interface ProviderHealth {
  available: boolean
  message: string
  setup_steps: string[]
  details?: Record<string, unknown>
}

export interface Health {
  status: string
  default_provider: string
  ffmpeg: { available: boolean }
  max_upload_mb: number
  file_ttl_hours: number
  providers: { comfyui: ProviderHealth; mock: ProviderHealth }
}

export interface GenerateParams {
  image_ids: string[]
  prompt: string
  duration: Duration
  aspect_ratio: AspectRatio
  motion: Motion
  provider: ProviderChoice
}

export interface GenerateResult {
  job_id: string
  provider: string
  is_mock: boolean
  notice: string | null
}

export interface JobStatus {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: number
  message: string
  error: string | null
  error_details?: string | null
  setup_steps?: string[]
  notice?: string | null
  is_mock?: boolean
  video_url: string | null
}

export class ApiError extends Error {
  status: number
  setupSteps: string[]

  constructor(message: string, status = 0, setupSteps: string[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.setupSteps = setupSteps
  }
}

const HTTP_MESSAGES: Record<number, string> = {
  404: 'العنصر المطلوب غير موجود.',
  413: `حجم الملف أكبر من الحد المسموح (${MAX_UPLOAD_MB} ميغابايت).`,
  415: 'نوع الملف غير مدعوم.',
  422: 'بيانات الطلب غير صالحة.',
  500: 'حدث خطأ في الخادم المحلي.',
  502: 'تعذّر الوصول إلى الخادم المحلي. تأكد من تشغيل الواجهة الخلفية (backend).',
  503: 'محرك الفيديو غير متاح حاليًا.',
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new ApiError('تعذّر الاتصال بالخادم المحلي. تأكد من تشغيل الواجهة الخلفية على المنفذ 8000.')
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail
    if (detail && typeof detail === 'object' && 'message' in detail) {
      const d = detail as { message: string; setup_steps?: string[] }
      throw new ApiError(d.message, response.status, d.setup_steps ?? [])
    }
    throw new ApiError(HTTP_MESSAGES[response.status] ?? `حدث خطأ غير متوقع (${response.status}).`, response.status)
  }
  return body as T
}

export function validateImageFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `الملف "${file.name}" ليس صورة مدعومة. الأنواع المسموح بها: JPG و PNG و WEBP.`
  }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    return `حجم الصورة "${file.name}" أكبر من ${MAX_UPLOAD_MB} ميغابايت.`
  }
  return null
}

export const api = {
  health: () => request<Health>('/api/health'),

  upload: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<UploadResult>('/api/upload', { method: 'POST', body: form })
  },

  deleteFile: (fileId: string) =>
    request<{ deleted: boolean }>(`/api/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),

  generate: (params: GenerateParams) =>
    request<GenerateResult>('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  status: (jobId: string) => request<JobStatus>(`/api/status/${encodeURIComponent(jobId)}`),

  videoUrl: (jobId: string, download = false) =>
    `${API_BASE}/api/video/${encodeURIComponent(jobId)}${download ? '?download=1' : ''}`,
}
