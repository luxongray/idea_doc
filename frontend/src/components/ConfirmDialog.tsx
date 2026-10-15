import { useEffect, useRef } from 'react'

/**
 * 二次确认弹窗
 *
 * 用来替换浏览器自带的 window.confirm：原生弹窗样式无法定制、会长住主线程，
 * 而且各家浏览器长得完全不一样。这里用普通 DOM 自绘，交互对齐原生弹窗——
 * 打开时焦点自动落到确认按钮、Esc 取消、点遮罩取消、点弹窗内部不关闭。
 *
 * @param props.open        是否展示
 * @param props.title       标题，一句话说清要确认什么
 * @param props.description 补充说明，可为空
 * @param props.confirmText 确认按钮文案
 * @param props.cancelText  取消按钮文案
 * @param props.danger      是否为危险操作（删除类会启用红色确认按钮）
 * @param props.onConfirm   点击确认后的回调
 * @param props.onCancel    取消回调（Esc、点遮罩、点取消按钮都会触发）
 * @returns 弹窗的 React 元素；未打开时返回 null
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  // 确认按钮：打开时把焦点送过来，键盘用户可以直接回车确认
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) {
      confirmRef.current?.focus()
    }
  }, [open])

  // Esc 取消。只在打开期间监听，关闭后立刻摘掉，避免影响页面其他快捷键
  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) {
    return null
  }

  return (
    // 遮罩层：点击空白处等同取消；role="presentation" 表示它只是装饰性容器
    <div
      role="presentation"
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl"
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-slate-900">
          {title}
        </h2>

        {description && (
          <p className="mt-2 text-sm leading-relaxed text-slate-500">{description}</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100"
          >
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-sm text-white transition ${
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-slate-900 hover:bg-slate-700'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
