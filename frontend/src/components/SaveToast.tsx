import type { SaveState } from '@/hooks/useDocumentSync'

/** 各保存状态对应的文案与配色 */
const STATE_META: Record<Exclude<SaveState, 'idle'>, { text: string; dot: string; tone: string }> = {
  saving: { text: '正在保存…', dot: 'bg-slate-400', tone: 'text-slate-500' },
  saved: { text: '已保存', dot: 'bg-emerald-500', tone: 'text-slate-500' },
  error: { text: '保存失败', dot: 'bg-red-500', tone: 'text-red-600' },
}

/**
 * 保存状态提示条
 *
 * 固定停在右下角，做成一颗小胶囊：不遮挡正文，也不抢注意力。
 * 「已保存」由一段 CSS 动画自行淡出，不需要额外的定时器与状态；
 * 「保存失败」则一直留在原地，等用户看到。
 *
 * @param props.state 当前保存状态
 * @returns 提示条的 React 元素；无需提示时不渲染任何内容
 */
export function SaveToast({ state }: { state: SaveState }) {
  if (state === 'idle') {
    return null
  }

  const meta = STATE_META[state]

  return (
    <div className="pointer-events-none fixed right-6 bottom-6 z-50">
      <div
        className={`flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs shadow-sm backdrop-blur ${
          state === 'saved' ? 'animate-[save-toast-fade_1.8s_ease-out_forwards]' : ''
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
        <span className={meta.tone}>{meta.text}</span>
      </div>
    </div>
  )
}
