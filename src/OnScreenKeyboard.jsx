import { useState } from 'react'

const TEXT_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
]

const NUMBER_ROWS = [
  ['1', '2', '3', '4', '5', '6'],
  ['7', '8', '9', '0', '.', 'backspace'],
]

export default function OnScreenKeyboard({ field, label, mode, value, maxLength, onChange, onClose }) {
  const [shifted, setShifted] = useState(false)

  const enter = (key) => {
    if (key === 'backspace') {
      onChange(Array.from(value).slice(0, -1).join(''))
      return
    }
    if (key === 'clear') {
      onChange('')
      return
    }
    if (key === '.' && value.includes('.')) return
    if (maxLength && value.length >= maxLength) return
    onChange(value + (shifted && /[a-z]/.test(key) ? key.toUpperCase() : key))
  }

  const keepFieldFocused = (event) => event.preventDefault()
  const rows = mode === 'number' ? NUMBER_ROWS : TEXT_ROWS

  return (
    <section className={`obj-onscreen-keyboard ${mode === 'number' ? 'numeric' : ''}`} aria-label={`${label} on-screen keyboard`}>
      <header className="obj-keyboard-header">
        <div><span>Entering</span><strong>{label}</strong></div>
        <button type="button" onPointerDown={keepFieldFocused} onClick={onClose} aria-label="Close on-screen keyboard">×</button>
      </header>

      <div className="obj-keyboard-rows">
        {rows.map((row, rowIndex) => (
          <div className="obj-keyboard-row" key={`${field}-${rowIndex}`}>
            {row.map((key) => (
              <button
                type="button"
                className={key === 'backspace' ? 'keyboard-action' : ''}
                key={key}
                onPointerDown={keepFieldFocused}
                onClick={() => enter(key)}
                aria-label={key === 'backspace' ? 'Delete last character' : key}
              >
                {key === 'backspace' ? '⌫' : shifted && /[a-z]/.test(key) ? key.toUpperCase() : key}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="obj-keyboard-actions">
        {mode === 'text' ? (
          <button type="button" className={shifted ? 'active' : ''} onPointerDown={keepFieldFocused} onClick={() => setShifted((current) => !current)}>Shift</button>
        ) : null}
        <button type="button" onPointerDown={keepFieldFocused} onClick={() => enter('clear')}>Clear</button>
        {mode === 'text' ? <button type="button" className="space" onPointerDown={keepFieldFocused} onClick={() => enter(' ')}>Space</button> : null}
        <button type="button" className="done" onPointerDown={keepFieldFocused} onClick={onClose}>Done</button>
      </div>
    </section>
  )
}
