# PPT 智能体真实冒烟验证

此验证仅在已登录 Codex CLI 的受控节点运行。它创建单独任务目录，调用 `presentation.create` 的真实 Codex 运行时，并检查 `presentation.pptx` 与 `ppt-qa.json` 是否生成。

```bash
MG_SMOKE_WORKSPACE=/home/middleground/data/workspaces/ppt-maker-smoke \
  ./node_modules/.bin/tsx scripts/smoke/ppt-maker.live.ts
```

不要在包含实际客户资料的目录中运行该脚本。常规单元测试使用替身运行时，不消耗 Codex 推理调用。
