import { useRef } from 'react'
import { ACCEPTED_TYPES } from '../api'

export interface ImageItem {
  key: string
  name: string
  previewUrl: string
  fileId: string | null
  uploading: boolean
  error: string | null
}

interface Props {
  images: ImageItem[]
  maxImages: number
  disabled?: boolean
  onAdd: (files: File[]) => void
  onRemove: (key: string) => void
}

export default function ImageUploader({ images, maxImages, disabled, onAdd, onRemove }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const canAdd = images.length < maxImages && !disabled

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return
    onAdd(Array.from(list))
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <section aria-labelledby="images-heading">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id="images-heading" className="text-base font-semibold">
          الصور
        </h2>
        <span className="text-xs text-slate-500">
          صورة أو صورتان · JPG / PNG / WEBP · حتى 20 ميغابايت
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {images.map((image, index) => (
          <figure
            key={image.key}
            className="relative aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
          >
            <img src={image.previewUrl} alt={`معاينة الصورة ${index + 1}`} className="h-full w-full object-cover" />
            <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-xs text-white">
              {images.length === 2 ? (index === 0 ? 'الصورة الأولى (البداية)' : 'الصورة الثانية (النهاية)') : image.name}
            </figcaption>
            {image.uploading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium">
                جارٍ الرفع...
              </div>
            )}
            {image.error && (
              <div role="alert" className="absolute inset-0 flex items-center justify-center bg-red-50/95 p-3 text-center text-xs text-red-700">
                {image.error}
              </div>
            )}
            <button
              type="button"
              onClick={() => onRemove(image.key)}
              disabled={disabled}
              aria-label={`حذف الصورة ${index + 1}`}
              className="absolute top-2 left-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-lg leading-none text-white transition hover:bg-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
            >
              ×
            </button>
          </figure>
        ))}

        {canAdd && (
          <label
            className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white p-3 text-center text-slate-500 transition hover:border-indigo-400 hover:text-indigo-600 focus-within:border-indigo-500"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              handleFiles(e.dataTransfer.files)
            }}
          >
            <span className="text-3xl leading-none" aria-hidden>
              +
            </span>
            <span className="text-sm font-medium">{images.length === 0 ? 'اختر صورة' : 'أضف صورة ثانية'}</span>
            <span className="text-xs">أو اسحبها إلى هنا</span>
            <input
              ref={inputRef}
              data-testid="file-input"
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              multiple={maxImages - images.length > 1}
              className="sr-only"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
        )}
      </div>
    </section>
  )
}
