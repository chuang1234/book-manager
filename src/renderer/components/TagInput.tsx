import { useState, type KeyboardEvent } from 'react'
import './TagInput.less'

interface Props {
  value: string[]
  onChange: (tags: string[]) => void
  /** 已有标签建议（来自 tag.list） */
  suggestions?: string[]
  placeholder?: string
}

const MAX_TAG_NAME = 20

/** 标签 chips 输入：回车/逗号提交、退格删尾、建议下拉点击追加 */
export default function TagInput({ value, onChange, suggestions = [], placeholder = '输入标签后回车' }: Props) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)

  const add = (raw: string) => {
    const name = raw.trim()
    if (!name || name.length > MAX_TAG_NAME || value.includes(name)) {
      setText('')
      return
    }
    onChange([...value, name])
    setText('')
  }

  const remove = (name: string) => onChange(value.filter((t) => t !== name))

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      add(text)
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      remove(value[value.length - 1])
    }
  }

  const trimmed = text.trim()
  const available = suggestions.filter((s) => !value.includes(s) && (!trimmed || s.includes(trimmed)))

  return (
    <div className="tag-input">
      <div className="tag-input-box">
        {value.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            <button
              className="tag-chip-remove"
              onClick={() => remove(t)}
              title="移除标签"
              type="button"
            >
              ✕
            </button>
          </span>
        ))}
        <input
          className="tag-input-field"
          value={text}
          placeholder={value.length ? '' : placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            add(text)
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {focused && available.length > 0 && (
        <div className="tag-input-suggest">
          {available.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              className="tag-suggest-item"
              onMouseDown={(e) => {
                e.preventDefault() // 保住输入框焦点
                add(s)
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
