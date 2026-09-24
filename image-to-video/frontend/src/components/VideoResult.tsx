import type { AspectRatio } from '../api'

interface Props {
  src: string
  downloadUrl: string
  isMock: boolean
  aspectRatio: AspectRatio
}

const ASPECT_CLASS: Record<AspectRatio, string> = {
  '9:16': 'aspect-[9/16] max-w-xs',
  '16:9': 'aspect-video max-w-full',
  '1:1': 'aspect-square max-w-sm',
}

export default function VideoResult({ src, downloadUrl, isMock, aspectRatio }: Props) {
  return (
    <section aria-labelledby="result-heading" className="space-y-3">
      <h2 id="result-heading" className="text-base font-semibold">
        النتيجة
      </h2>
      {isMock && (
        <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
          هذا فيديو تجريبي من وضع المعاينة (عرض شرائح بحركة Ken Burns) وليس فيديو مولّدًا بالذكاء الاصطناعي.
        </p>
      )}
      <div className={`mx-auto w-full overflow-hidden rounded-xl bg-black ${ASPECT_CLASS[aspectRatio]}`}>
        <video data-testid="result-video" src={src} controls playsInline loop className="h-full w-full object-contain" />
      </div>
      <a
        href={downloadUrl}
        download
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-indigo-600 px-4 py-3 font-semibold text-indigo-700 transition hover:bg-indigo-50"
      >
        ⬇ تنزيل الفيديو (MP4)
      </a>
    </section>
  )
}
