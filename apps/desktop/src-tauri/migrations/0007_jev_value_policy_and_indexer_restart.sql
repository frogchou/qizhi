CREATE TABLE IF NOT EXISTS jev_value_policy (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  instructions TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  valuable_threshold REAL NOT NULL
);

INSERT OR IGNORE INTO jev_value_policy(id,instructions,criteria_json,valuable_threshold)
VALUES (
  1,
  '根据文件名和实际内容，评估这个文件对计算机办公工作的长期知识价值。重点考虑是否包含可复用的知识、分析、决策、方案、数据、重要代码或正式交付成果；不要仅因篇幅长而给高分。',
  '["几乎没有工作价值：缓存、模板噪声、空内容、自动生成或不可复用的临时文件","较低工作价值：重复内容、短期中间产物，后续很少需要查找或复用","一般工作价值：记录了具体工作信息，对当前任务或个人回顾有帮助","较高工作价值：包含可复用的知识、分析、决策、方案、数据或重要代码","很高工作价值：关键交付物、正式结论、核心设计或值得长期进入知识库的资料"]',
  2.5
);

-- Version 0.1.0 did not restart an already running Windows service during
-- upgrade, so its first history-replay migration might never have executed.
-- Force one idempotent rebuild after the fixed installer restarts the service.
DELETE FROM ntfs_checkpoints;
