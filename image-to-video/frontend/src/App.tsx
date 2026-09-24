import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  validateImageFile,
  type AspectRatio,
  type Duration,
  type Health,
  type Motion,
  type ProviderChoice,
} from './api'
import EngineStatus, { SetupSteps } from './components/EngineStatus'
import ImageUploader, { type ImageItem } from './components/ImageUploader'
import SettingsPanel from './components/SettingsPanel'
import VideoResult from './components/VideoResult'

export const DEFAULT_PROMPT =
  'فيديو واقعي لحفل زفاف بسيط، يظهر فيه الشخصان كزوجين، مع ابتسامة طبيعية، وضيوف يصورونهما بالهواتف، إضاءة دافئة، حركة كاميرا سينمائية ناعمة، الحفاظ على ملامح الوجهين بدون تشويه، فيديو عمودي 9:16.'

const MAX_IMAGES = 2
const POLL_MS = 1500

interface JobState {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: number
  message: string
  isMock: boolean
  notice: string | null
  aspectRatio: AspectRatio
}

interface ErrorState {
  message: string
  steps: string[]
}

let keyCounter = 0

export default function App() {
  const [images, setImages] = useState<ImageItem[]>([])
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [duration, setDuration] = useState<Duration>(5)
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16')
  const [motion, setMotion] = useState<Motion>('medium')
  const [provider, setProvider] = useState<ProviderChoice>('auto')
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [error, setError] = useState<ErrorState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const imagesRef = useRef(images)
  useEffect(() => {
    imagesRef.current = images
  }, [images])

  const loadHealth = useCallback(
    () =>
      api.health().then(
        (result) => {
          setHealth(result)
          setHealthError(null)
        },
        (err: unknown) => {
          setHealth(null)
          setHealthError(err instanceof ApiError ? err.message : 'تعذّر فحص حالة الخادم.')
        },
      ),
    [],
  )

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  // Revoke preview URLs on unmount.
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [])

  const generating = submitting || job?.status === 'queued' || job?.status === 'running'

  const activeJobId = job && (job.status === 'queued' || job.status === 'running') ? job.id : null

  // Poll job status while it is running.
  useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const status = await api.status(activeJobId)
        if (cancelled) return
        failures = 0
        setJob((current) =>
          current && current.id === status.id
            ? { ...current, status: status.status, progress: status.progress, message: status.message }
            : current,
        )
        if (status.status === 'failed') {
          setError({ message: status.error ?? 'فشل توليد الفيديو.', steps: status.setup_steps ?? [] })
          return
        }
        if (status.status === 'completed') return
      } catch (err) {
        if (cancelled) return
        failures += 1
        if (failures >= 5) {
          setError({ message: err instanceof ApiError ? err.message : 'انقطع الاتصال بالخادم.', steps: [] })
          setJob((current) => (current ? { ...current, status: 'failed' } : current))
          return
        }
      }
      timer = setTimeout(poll, POLL_MS)
    }
    timer = setTimeout(poll, POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeJobId])

  const addImages = (files: File[]) => {
    setError(null)
    const free = MAX_IMAGES - imagesRef.current.length
    if (files.length > free) {
      setError({ message: 'يمكنك رفع صورتين كحد أقصى.', steps: [] })
    }
    for (const file of files.slice(0, Math.max(0, free))) {
      const problem = validateImageFile(file)
      if (problem) {
        setError({ message: problem, steps: [] })
        continue
      }
      const key = `img-${++keyCounter}`
      const item: ImageItem = {
        key,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
        fileId: null,
        uploading: true,
        error: null,
      }
      setImages((current) => [...current, item])
      api
        .upload(file)
        .then((result) =>
          setImages((current) =>
            current.map((image) => (image.key === key ? { ...image, fileId: result.file_id, uploading: false } : image)),
          ),
        )
        .catch((err: unknown) =>
          setImages((current) =>
            current.map((image) =>
              image.key === key
                ? { ...image, uploading: false, error: err instanceof ApiError ? err.message : 'فشل رفع الصورة.' }
                : image,
            ),
          ),
        )
    }
  }

  const removeImage = (key: string) => {
    const image = imagesRef.current.find((item) => item.key === key)
    if (!image) return
    URL.revokeObjectURL(image.previewUrl)
    setImages((current) => current.filter((item) => item.key !== key))
    if (image.fileId) {
      api.deleteFile(image.fileId).catch(() => undefined)
    }
  }

  const readyImages = images.filter((image) => image.fileId && !image.error)
  const imagesPending = images.some((image) => image.uploading)
  const imagesBroken = images.some((image) => image.error)
  const canGenerate =
    !generating && readyImages.length > 0 && !imagesPending && !imagesBroken && prompt.trim().length > 0

  const generate = async () => {
    setError(null)
    if (readyImages.length === 0) {
      setError({ message: 'ارفع صورة واحدة على الأقل.', steps: [] })
      return
    }
    if (!prompt.trim()) {
      setError({ message: 'اكتب وصفًا للفيديو في خانة البرومبت.', steps: [] })
      return
    }
    setSubmitting(true)
    setJob(null)
    try {
      const result = await api.generate({
        image_ids: readyImages.map((image) => image.fileId!),
        prompt: prompt.trim(),
        duration,
        aspect_ratio: aspectRatio,
        motion,
        provider,
      })
      setJob({
        id: result.job_id,
        status: 'queued',
        progress: 0,
        message: 'في قائمة الانتظار...',
        isMock: result.is_mock,
        notice: result.notice,
        aspectRatio,
      })
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { message: err.message, steps: err.setupSteps }
          : { message: 'حدث خطأ غير متوقع.', steps: [] },
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-5">
          <h1 className="text-xl font-bold sm:text-2xl">تحويل الصور إلى فيديو</h1>
          <p className="mt-1 text-sm text-slate-600">مجاني ومحلي بالكامل: الصور لا تغادر جهازك.</p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <p role="note" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900">
          استخدم صور الأشخاص الحقيقيين بعد الحصول على موافقتهم.
        </p>

        <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <EngineStatus
            health={health}
            healthError={healthError}
            provider={provider}
            disabled={generating}
            onProvider={setProvider}
            onRetry={loadHealth}
          />

          <ImageUploader images={images} maxImages={MAX_IMAGES} disabled={generating} onAdd={addImages} onRemove={removeImage} />

          <div>
            <label htmlFor="prompt" className="mb-1.5 block text-base font-semibold">
              برومبت تحويل الصور إلى فيديو
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={generating}
              rows={5}
              maxLength={2000}
              aria-describedby="prompt-count"
              className="w-full resize-y rounded-xl border border-slate-300 p-3 leading-relaxed focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-50"
            />
            <span id="prompt-count" className="mt-1 block text-xs text-slate-500">
              {prompt.length} / 2000
            </span>
          </div>

          <SettingsPanel
            duration={duration}
            aspectRatio={aspectRatio}
            motion={motion}
            disabled={generating}
            onDuration={setDuration}
            onAspectRatio={setAspectRatio}
            onMotion={setMotion}
          />

          <button
            type="button"
            onClick={generate}
            disabled={!canGenerate}
            className="w-full rounded-xl bg-indigo-600 px-4 py-3.5 text-lg font-bold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-300 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {generating ? 'جارٍ التوليد...' : 'توليد الفيديو'}
          </button>

          {job && job.status !== 'failed' && job.status !== 'completed' && (
            <div className="space-y-2" aria-live="polite">
              {job.notice && <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">{job.notice}</p>}
              <div className="flex justify-between text-sm">
                <span>{job.message}</span>
                <span className="font-semibold tabular-nums">{job.progress}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="تقدم التوليد"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={job.progress}
                className="h-3 overflow-hidden rounded-full bg-slate-200"
              >
                <div className="h-full rounded-full bg-indigo-600 transition-all duration-500" style={{ width: `${Math.max(3, job.progress)}%` }} />
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-semibold">{error.message}</p>
              <SetupSteps steps={error.steps} />
            </div>
          )}
        </div>

        {job?.status === 'completed' && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <VideoResult
              src={api.videoUrl(job.id)}
              downloadUrl={api.videoUrl(job.id, true)}
              isMock={job.isMock}
              aspectRatio={job.aspectRatio}
            />
          </div>
        )}

        <footer className="pb-6 text-center text-xs text-slate-500">
          تُحذف الصور والفيديوهات تلقائيًا من جهازك بعد {health?.file_ttl_hours ?? 24} ساعة.
        </footer>
      </main>
    </div>
  )
}
