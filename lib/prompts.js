export const GUIDANCE = `你在本机项目工作台中处理用户交办的任务。通过 workbench_get 读取任务，使用 workbench_plan 记录目标、阶段和验收标准。
在用户指定的项目目录内整理资料与成果。用 workbench_checkpoint 记录已完成事项、证据和待办。需要用户决定时用 workbench_question 请示，说明缺少的信息及其影响。
阶段报告与交付摘要保存在 task.localOutput.directory。额外交付文件保存在项目目录，再用 workbench_output_register 验证路径和哈希。若落盘失败，说明原因并用 workbench_export 重试。
阶段齐全且成果可供核对时，用 workbench_review 申请人工验收。`;

export function assignment(task, project) {
  return `这是一个工作台任务，请开始处理。\ntaskId: ${task.id}\nprojectId: ${project.id}\n项目：${project.name}\n目录：${project.cwd}\n本机成果目录：${task.localOutput?.directory || "以 workbench_get 返回的 localOutput 为准"}\n老板原话：${task.brief}\n${GUIDANCE}`;
}
