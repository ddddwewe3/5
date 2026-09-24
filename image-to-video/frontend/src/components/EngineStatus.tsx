import type { Health, ProviderChoice } from '../api'

interface Props {
  health: Health | null
  healthError: string | null
  provider: ProviderChoice
  disabled?: boolean
  onProvider: (value: ProviderChoice) => void
  onRetry: () => void
}

export function SetupSteps({ steps }: { steps: string[] }) {
  if (steps.length === 0) return null
  return (
    <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm leading-relaxed">
      {steps.map((step) => (
        <li key={step} className="break-words">
          {step}
        </li>
      ))}
    </ol>
  )
}

export default function EngineStatus({ health, healthError, provider, disabled, onProvider, onRetry }: Props) {
  if (healthError) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p className="font-semibold">{healthError}</p>
        <p className="mt-1">شغّل الواجهة الخلفية ثم أعد المحاولة (راجع README).</p>
        <button type="button" onClick={onRetry} className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700">
          إعادة المحاولة
        </button>
      </div>
    )
  }
  if (!health) {
    return <p className="text-sm text-slate-500">جارٍ فحص محرك الفيديو...</p>
  }

  const comfy = health.providers.comfyui
  return (
    <section aria-label="محرك الفيديو" className="space-y-3">
      <div
        className={`rounded-xl border p-4 text-sm ${
          comfy.available ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}
      >
        <p className="font-semibold">
          {comfy.available ? '✓ ' : '⚠ '}
          {comfy.message}
        </p>
        {!comfy.available && (
          <details className="mt-2">
            <summary className="cursor-pointer font-medium">كيف أثبّت النموذج المحلي؟</summary>
            <SetupSteps steps={comfy.setup_steps} />
          </details>
        )}
        {!comfy.available && (
          <button type="button" onClick={onRetry} className="mt-2 text-xs font-medium underline underline-offset-2">
            إعادة الفحص
          </button>
        )}
      </div>

      <label className="block text-sm">
        <span className="mb-1.5 block font-medium text-slate-700">المحرك</span>
        <select
          value={provider}
          disabled={disabled}
          onChange={(e) => onProvider(e.target.value as ProviderChoice)}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        >
          <option value="auto">تلقائي (أول نموذج مثبت على ComfyUI)</option>
          <option value="comfyui">ComfyUI المحلي (ذكاء اصطناعي)</option>
          <option value="mock">عرض تجريبي (يتطلب ENABLE_DEMO_MODE، ليس ذكاءً اصطناعيًا)</option>
        </select>
      </label>
    </section>
  )
}
