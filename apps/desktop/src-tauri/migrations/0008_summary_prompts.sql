CREATE TABLE IF NOT EXISTS openai_summary_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model TEXT NOT NULL
);

INSERT OR IGNORE INTO openai_summary_settings(id, model) VALUES (1, 'gpt-5.6');

CREATE TABLE IF NOT EXISTS summary_prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
);

INSERT INTO summary_prompt_templates(title, prompt, sort_order, is_default)
SELECT '今日工作总结', '根据所选文件，总结今天完成的工作、关键成果、问题风险和下一步计划。只依据文件内容，不要编造。', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM summary_prompt_templates);
INSERT INTO summary_prompt_templates(title, prompt, sort_order, is_default)
SELECT '一句话总结工作', '用一句准确、具体的话概括所选文件反映的工作。', 1, 0
WHERE (SELECT COUNT(*) FROM summary_prompt_templates) = 1;
INSERT INTO summary_prompt_templates(title, prompt, sort_order, is_default)
SELECT '会议总结', '整理会议主题、关键讨论、已作决定、负责人和待办事项。', 2, 0
WHERE (SELECT COUNT(*) FROM summary_prompt_templates) = 2;
INSERT INTO summary_prompt_templates(title, prompt, sort_order, is_default)
SELECT '实验总结', '整理实验目标、方法、数据结果、结论、异常和后续实验建议。', 3, 0
WHERE (SELECT COUNT(*) FROM summary_prompt_templates) = 3;
INSERT INTO summary_prompt_templates(title, prompt, sort_order, is_default)
SELECT '翻译全文', '将所选文件中的正文完整翻译成简体中文，保留原有结构；已是中文的内容保持不变。', 4, 0
WHERE (SELECT COUNT(*) FROM summary_prompt_templates) = 4;
