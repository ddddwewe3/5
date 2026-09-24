import type { AspectRatio, Duration, Motion } from '../api'

interface Option<T> {
  value: T
  label: string
}

function Segmented<T extends string | number>({
  name,
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  name: string
  label: string
  options: Option<T>[]
  value: T
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium text-slate-700">{label}</legend>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
        {options.map((option) => {
          const checked = option.value === value
          return (
            <label
              key={String(option.value)}
              className={`cursor-pointer rounded-lg px-2 py-2 text-center text-sm transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 ${
                checked ? 'bg-white font-semibold text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={String(option.value)}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

interface Props {
  duration: Duration
  aspectRatio: AspectRatio
  motion: Motion
  disabled?: boolean
  onDuration: (value: Duration) => void
  onAspectRatio: (value: AspectRatio) => void
  onMotion: (value: Motion) => void
}

export default function SettingsPanel(props: Props) {
  return (
    <section aria-label="الإعدادات" className="grid gap-4 sm:grid-cols-3">
      <Segmented<Duration>
        name="duration"
        label="المدة"
        value={props.duration}
        disabled={props.disabled}
        onChange={props.onDuration}
        options={[
          { value: 3, label: '3 ثوانٍ' },
          { value: 5, label: '5 ثوانٍ' },
          { value: 8, label: '8 ثوانٍ' },
        ]}
      />
      <Segmented<AspectRatio>
        name="aspect"
        label="نسبة الأبعاد"
        value={props.aspectRatio}
        disabled={props.disabled}
        onChange={props.onAspectRatio}
        options={[
          { value: '9:16', label: '9:16' },
          { value: '16:9', label: '16:9' },
          { value: '1:1', label: '1:1' },
        ]}
      />
      <Segmented<Motion>
        name="motion"
        label="قوة الحركة"
        value={props.motion}
        disabled={props.disabled}
        onChange={props.onMotion}
        options={[
          { value: 'low', label: 'منخفضة' },
          { value: 'medium', label: 'متوسطة' },
          { value: 'high', label: 'عالية' },
        ]}
      />
    </section>
  )
}
