# 能力咨询与停止任务

通过原有需求信号接口提交“你能帮助我做什么？”即可查询已审核、就绪的能力。中台从当前目录生成答复。附件、复合指令和其他自然语言需求进入 Codex 规划器，规划器可以直接回答咨询或者编排实际工作。任务详情的 `planSummary.mode=direct_answer` 标识直接答复，正文在 `planSummary.summary` 中。选择人工验收的任务仍需确认交付。

在任务详情右上角点击“停止任务”，或调用管理员接口：

```sh
curl -X POST -H "Authorization: Bearer $MG_ADMIN_TOKEN" \
  "http://middleground.example.invalid:3010/v1/tasks/$TASK_ID/stop"
```

任务先进入 `stopping`。中台取消该任务的规划进程组，等正在发起的节点启动请求返回，再要求节点管理服务逐个停止该任务的运行单元。已确认停止的实例才解除停止标记。全部完成后返回 HTTP 200 和 `{"state":"cancelled"}`。工作目录、已完成节点和已归档产物保留。重复停止已停止的任务返回同一结果，其他已结束任务返回 409。实例停止失败时任务停留在 `stopping`，可点击“重试停止”；中台重启也会重试待完成的停止操作。

查看 SSE 活动 `stop_requested`、`stop_failed`、`task_cancelled` 可区分请求送达、实例停止待重试和停止完成。
