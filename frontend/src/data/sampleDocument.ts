import type { DocDocument, ParagraphBlock } from '@/types/document'

/**
 * 构造一个不带颜色的普通文字块
 *
 * 静态数据里绝大多数段落都没有行内颜色，用这个辅助函数避免反复书写 segments 结构。
 *
 * @param id   块 id
 * @param text 该行文字
 * @return 普通文字块
 */
function paragraph(id: string, text: string): ParagraphBlock {
  return { id, type: 'paragraph', segments: [{ text }] }
}

/**
 * 文档页面的静态测试数据
 *
 * 当前阶段后端尚未提供文档接口，这里先用一份包含 1-6 级标题的示例文档把页面形态跑通。
 * 后续接入接口时，只需把本文件替换为请求结果，数据结构保持一致即可。
 */
export const sampleDocument: DocDocument = {
  id: 'doc-sample',
  title: '示例文档',
  updatedAt: '2026-10-15 10:20',
  blocks: [
    { id: 'heading-sample', type: 'heading', level: 1, text: '示例文档' },
    paragraph('paragraph-sample-intro', '这是一份用于展示编辑器能力的示例文档，内容均为虚构，可以随意修改。'),

    { id: 'heading-start', type: 'heading', level: 2, text: '一、快速上手' },
    paragraph('paragraph-start', '正文由一行行「块」组成，标题会自动出现在右侧的大纲里。'),
    { id: 'heading-start-level', type: 'heading', level: 3, text: '标题层级' },
    paragraph('paragraph-start-level', '标题支持 1 到 6 级，层级越深字号越小，大纲里的缩进也会跟着变化。'),
    { id: 'heading-start-color', type: 'heading', level: 3, text: '行内染色' },
    {
      id: 'paragraph-start-color',
      type: 'paragraph',
      segments: [
        { text: '选中一段文字后可以单独染色，例如 ' },
        { text: '红色', color: 'red' },
        { text: '、' },
        { text: '蓝色', color: 'blue' },
        { text: '、' },
        { text: '绿色', color: 'green' },
        { text: '、' },
        { text: '黄色', color: 'yellow' },
        { text: '，其余文字保持原样。' },
      ],
    },

    { id: 'heading-edit', type: 'heading', level: 2, text: '二、编辑操作' },
    { id: 'heading-edit-break', type: 'heading', level: 3, text: '换行与合并' },
    paragraph('paragraph-edit-break', '回车在光标处拆出一行；行首退格并入上一行，行尾删除并入下一行。'),
    { id: 'heading-edit-undo', type: 'heading', level: 3, text: '撤销与重做' },
    paragraph('paragraph-edit-undo', '标题级别调整、染色、换行等操作都可以撤销，连续打字则会合并成一步。'),
    { id: 'heading-edit-paste', type: 'heading', level: 3, text: '粘贴' },
    paragraph('paragraph-edit-paste', '从网页复制的标题和彩色文字，粘贴进来会保留原来的层级与颜色。'),

    { id: 'heading-structure', type: 'heading', level: 2, text: '三、结构参考' },
    paragraph('paragraph-structure', '下面用一组多层标题，说明大纲在深层层级下的样子。'),
    { id: 'heading-structure-3', type: 'heading', level: 3, text: '第三级标题' },
    { id: 'heading-structure-4', type: 'heading', level: 4, text: '第四级标题' },
    { id: 'heading-structure-5', type: 'heading', level: 5, text: '第五级标题' },
    { id: 'heading-structure-6', type: 'heading', level: 6, text: '第六级标题' },
    paragraph('paragraph-structure-6', '六级标题用于细分到最末一层，再往下就应该另起一篇文档了。'),

    { id: 'heading-faq', type: 'heading', level: 2, text: '四、常见问题' },
    { id: 'heading-faq-outline', type: 'heading', level: 3, text: '为什么某个标题没出现在大纲里' },
    paragraph('paragraph-faq-outline', '只有标题块会进入大纲，普通文字行不会。'),
    { id: 'heading-faq-block', type: 'heading', level: 3, text: '表格和代码块在哪里' },
    paragraph('paragraph-faq-block', '这两类块还没有实现，后续会作为新的块类型加入。'),
  ],
}
