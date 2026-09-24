import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App, { DEFAULT_PROMPT } from './App'
import { validateImageFile } from './api'

const health = {
  status: 'ok',
  default_provider: 'auto',
  ffmpeg: { available: true },
  max_upload_mb: 20,
  file_ttl_hours: 24,
  providers: {
    comfyui: {
      available: false,
      message: 'ComfyUI غير متاح على http://127.0.0.1:8188.',
      setup_steps: ['ثبّت ComfyUI'],
    },
    mock: { available: true, message: 'وضع المعاينة', setup_steps: [] },
  },
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

function png(name = 'a.png', size = 1000, type = 'image/png') {
  return new File([new Uint8Array(size)], name, { type })
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>

function mockFetch(handler: Handler) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('App', () => {
  it('renders Arabic RTL UI with the default prompt, settings and consent note', async () => {
    mockFetch(() => json(health))
    render(<App />)

    expect(screen.getByRole('heading', { name: 'تحويل الصور إلى فيديو' })).toBeInTheDocument()
    expect(screen.getByLabelText('برومبت تحويل الصور إلى فيديو')).toHaveValue(DEFAULT_PROMPT)
    expect(screen.getByText('استخدم صور الأشخاص الحقيقيين بعد الحصول على موافقتهم.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '5 ثوانٍ' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '9:16' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'متوسطة' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'توليد الفيديو' })).toBeDisabled()

    expect(await screen.findByText(/ComfyUI غير متاح/)).toBeInTheDocument()
    expect(screen.getByText('ثبّت ComfyUI')).toBeInTheDocument()
  })

  it('shows an Arabic error when the backend is not running', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<App />)
    expect(await screen.findByText(/تعذّر الاتصال بالخادم المحلي/)).toBeInTheDocument()
  })

  it('rejects unsupported and oversized files on the client', async () => {
    mockFetch(() => json(health))
    render(<App />)
    const user = userEvent.setup({ applyAccept: false })
    await user.upload(screen.getByTestId('file-input'), new File(['MZ'], 'virus.exe', { type: 'application/x-msdownload' }))
    expect(await screen.findByText(/ليس صورة مدعومة/)).toBeInTheDocument()

    expect(validateImageFile(png('big.png', 21 * 1024 * 1024))).toMatch(/أكبر من 20/)
    expect(validateImageFile(png('ok.webp', 10, 'image/webp'))).toBeNull()
  })

  it('uploads, previews, removes an image and deletes it on the server', async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/health') return json(health)
      if (url === '/api/upload') return json({ file_id: 'f'.repeat(32), width: 100, height: 100, size_bytes: 10 }, 201)
      if (url.startsWith('/api/files/') && init?.method === 'DELETE') return json({ deleted: true })
      return json({}, 404)
    })
    render(<App />)
    const user = userEvent.setup()
    await user.upload(screen.getByTestId('file-input'), png())

    expect(await screen.findByAltText('معاينة الصورة 1')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'توليد الفيديو' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'حذف الصورة 1' }))
    expect(screen.queryByAltText('معاينة الصورة 1')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/files/${'f'.repeat(32)}`, expect.objectContaining({ method: 'DELETE' })),
    )
  })

  it('limits uploads to two images', async () => {
    let n = 0
    mockFetch((url) => {
      if (url === '/api/health') return json(health)
      n += 1
      return json({ file_id: String(n).repeat(32).slice(0, 32), width: 100, height: 100, size_bytes: 10 }, 201)
    })
    render(<App />)
    const user = userEvent.setup()
    await user.upload(screen.getByTestId('file-input'), [png('1.png'), png('2.png'), png('3.png')])
    expect(await screen.findByText('يمكنك رفع صورتين كحد أقصى.')).toBeInTheDocument()
    expect(screen.getAllByAltText(/معاينة الصورة/)).toHaveLength(2)
    expect(screen.queryByTestId('file-input')).not.toBeInTheDocument()
  })

  it('generates a video, shows progress, then the player, mock label and download link', async () => {
    let polls = 0
    const fetchMock = mockFetch((url) => {
      if (url === '/api/health') return json(health)
      if (url === '/api/upload') return json({ file_id: 'a'.repeat(32), width: 100, height: 100, size_bytes: 10 }, 201)
      if (url === '/api/generate') {
        return json({ job_id: 'j'.repeat(32), provider: 'mock', is_mock: true, notice: 'وضع المعاينة: ليس ذكاءً اصطناعيًا' }, 202)
      }
      if (url.startsWith('/api/status/')) {
        polls += 1
        return json(
          polls < 2
            ? { id: 'j'.repeat(32), status: 'running', progress: 40, message: 'جارٍ التوليد', error: null, video_url: null }
            : { id: 'j'.repeat(32), status: 'completed', progress: 100, message: 'اكتمل', error: null, video_url: '/api/video/x' },
        )
      }
      return json({}, 404)
    })
    render(<App />)
    const user = userEvent.setup()
    await user.upload(screen.getByTestId('file-input'), png())
    await waitFor(() => expect(screen.getByRole('button', { name: 'توليد الفيديو' })).toBeEnabled())
    await user.click(screen.getByRole('radio', { name: '3 ثوانٍ' }))
    await user.click(screen.getByRole('radio', { name: '16:9' }))
    await user.click(screen.getByRole('radio', { name: 'عالية' }))
    await user.click(screen.getByRole('button', { name: 'توليد الفيديو' }))

    expect(await screen.findByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'جارٍ التوليد...' })).toBeDisabled()

    const body = JSON.parse(fetchMock.mock.calls.find(([u]) => u === '/api/generate')![1]!.body as string)
    expect(body).toMatchObject({ image_ids: ['a'.repeat(32)], duration: 3, aspect_ratio: '16:9', motion: 'high', provider: 'auto' })
    expect(body.prompt).toBe(DEFAULT_PROMPT)

    const video = await screen.findByTestId('result-video', {}, { timeout: 6000 })
    expect(video).toHaveAttribute('src', `/api/video/${'j'.repeat(32)}`)
    expect(screen.getByText(/ليس فيديو مولّدًا بالذكاء الاصطناعي/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /تنزيل الفيديو/ })).toHaveAttribute('href', `/api/video/${'j'.repeat(32)}?download=1`)
  }, 10000)

  it('shows Arabic setup steps when ComfyUI is forced but unavailable', async () => {
    mockFetch((url) => {
      if (url === '/api/health') return json(health)
      if (url === '/api/upload') return json({ file_id: 'a'.repeat(32), width: 100, height: 100, size_bytes: 10 }, 201)
      if (url === '/api/generate') {
        return json({ detail: { message: 'ComfyUI غير متاح.', setup_steps: ['شغّل ComfyUI على المنفذ 8188'] } }, 503)
      }
      return json({}, 404)
    })
    render(<App />)
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('المحرك'), 'comfyui')
    await user.upload(screen.getByTestId('file-input'), png())
    await waitFor(() => expect(screen.getByRole('button', { name: 'توليد الفيديو' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'توليد الفيديو' }))

    const alert = await screen.findByText('ComfyUI غير متاح.')
    expect(alert.closest('[role="alert"]')).toHaveTextContent('شغّل ComfyUI على المنفذ 8188')
  })
})
