import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TASK_INPUT_OWNER, type TaskInputService } from './task-input.service.js';
import type { TaskOrchestrationService } from './task-orchestration.service.js';
import type { TaskArtifactService } from './task-artifact.service.js';
import { nodeAnswer, selectDeliveryNodes, type DeliveryResultNode } from './delivery-content.js';

export type RevisionDecision = 'revise' | 'amend';
export type RevisionRequest = {decision: RevisionDecision; reviewId?: unknown; message?: unknown; inputIds?: unknown};
export type RevisionReceipt = {taskId:string; state:'planning'; decision:RevisionDecision; revisionId:string; revisionNumber:number; reviewId:string|null; inputIds:string[]};

const invalid = (message: string) => new BadRequestException({code:'invalid_revision',message});
const stale = () => new ConflictException({code:'stale_review',message:'该工单或验收轮次已变化，请刷新后再提交。'});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requestRevision(taskId: string, body: RevisionRequest, key: string|undefined,
  inputs: TaskInputService, orchestration: TaskOrchestrationService, archive:TaskArtifactService): Promise<RevisionReceipt> {
  if (!key || !/^[A-Za-z0-9._-]{1,160}$/.test(key)) throw invalid('请提供有效的 Idempotency-Key。');
  if (body.message !== undefined && (typeof body.message!=='string'||body.message.length>4000||body.message.includes('\0'))) throw invalid('反馈文字限 4000 字。');
  if (body.reviewId!=null && (typeof body.reviewId!=='string'||!uuid.test(body.reviewId))) throw invalid('验收轮次标识无效。');
  const message = typeof body.message==='string' ? body.message.trim() : '';
  const reviewId = typeof body.reviewId==='string' ? body.reviewId.toLowerCase() : null;
  const ids = body.inputIds===undefined ? [] : body.inputIds;
  if (!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!uuid.test(id))||new Set(ids).size!==ids.length) throw invalid('附件列表必须为不同的暂存上传标识。');
  const uploadIds: string[] = [...ids].sort();
  if (body.decision==='amend' && !message && !uploadIds.length) throw invalid('补充需求至少需要文字说明或一份附件。');

  const { receipt, enqueue } = await inputs.withFrozenUploads(taskId,uploadIds,TASK_INPUT_OWNER,async(manager,freeze)=>{
    const [task] = await manager.query(`SELECT id,state,goal,revision_number,effective_goal,planner_summary,current_plan_version
      FROM tasks WHERE id=$1 FOR UPDATE`,[taskId]);
    if (!task) throw new NotFoundException('未找到工单。');
    const [prior] = await manager.query('SELECT * FROM task_revisions WHERE task_id=$1 AND idempotency_key=$2',[taskId,key]);
    if (prior) {
      if (prior.decision!==body.decision||prior.message!==message||prior.review_id!==reviewId||JSON.stringify(prior.upload_ids)!==JSON.stringify(uploadIds))
        throw new ConflictException({code:'idempotency_conflict',message:'同一请求标识已用于不同的修订内容。'});
      const receipt: RevisionReceipt = {taskId,state:'planning',decision:body.decision,revisionId:prior.id,
        revisionNumber:prior.revision_number,reviewId,inputIds:prior.input_ids};
      return {receipt,enqueue:false};
    }
    const [current] = await manager.query(`SELECT id,round,criteria,assessment,decision FROM task_acceptance_rounds
      WHERE task_id=$1 AND revision_number=$2 ORDER BY round DESC LIMIT 1 FOR UPDATE`,[taskId,task.revision_number]);
    if (task.state!=='awaiting_review'||(current?.id??null)!==reviewId||current?.decision) throw stale();
    const frozen = await freeze();
    const revisionNumber = Number(task.revision_number)+1;
    const revisionId = randomUUID();
    const title = body.decision==='amend'?'补充需求':'退回重制';
    const previousNodes: DeliveryResultNode[] = await manager.query(`SELECT n.node_key AS "nodeKey", n.capability,n.output,n.depends_on AS "dependsOn"
      FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1
      AND p.version=coalesce($2,(SELECT max(version) FROM task_plans WHERE task_id=$1)) AND n.output IS NOT NULL ORDER BY n.created_at,n.id`,
      [taskId,task.current_plan_version]);
    const previousAnswer = selectDeliveryNodes(previousNodes).map(n=>({node:n.nodeKey,capability:n.capability,answer:nodeAnswer(n)}));
    const artifacts = await manager.query(`SELECT DISTINCT ON (a.task_node_id,a.original_path) a.id,a.file_name AS "fileName",a.sha256,a.revision,n.node_key AS node FROM task_artifacts a
      JOIN task_nodes n ON n.id=a.task_node_id JOIN task_plans p ON p.id=n.plan_id WHERE a.task_id=$1 AND
      p.version=coalesce($2,(SELECT max(version) FROM task_plans WHERE task_id=$1))
      ORDER BY a.task_node_id,a.original_path,a.revision DESC,a.id`,[taskId,task.current_plan_version]);
    for(const artifact of artifacts) {
      const file=await archive.openForDownload(taskId,artifact.id,manager);
      if(!file.sizeBytes) continue;
      const reusable=randomUUID();
      const [material]=await manager.query(`INSERT INTO task_inputs(id,task_id,source_type,display_name,original_filename,media_type,size_bytes,sha256,workspace_relative_path,source_ref,provenance)
        VALUES($1,$2,'agent_artifact',$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
        ON CONFLICT(task_id,workspace_relative_path) DO UPDATE SET workspace_relative_path=excluded.workspace_relative_path RETURNING id`,
      [reusable,taskId,('上一版 · '+file.fileName).slice(0,255),file.fileName,file.mediaType,file.sizeBytes,file.sha256,file.storagePath,
        JSON.stringify({artifactId:file.id}),JSON.stringify({sourceType:'agent_artifact',artifactId:file.id,sourceAttemptId:file.taskAttemptId})]);
      artifact.inputId=material.id;
    }
    const previousDelivery = {planVersion:task.current_plan_version,planner:task.planner_summary,answers:previousAnswer,artifacts,
      assessment:current?.assessment??null,criteria:current?.criteria??[]};
    const requested = message || (body.decision==='revise'?'重新制作本次交付，修正上一轮核验所指出的问题。':'结合本次新提交的附件完善交付。');
    const effectiveGoal = [task.effective_goal??task.goal,`第 ${revisionNumber} 次人工${title}：${requested}`,
      ...frozen.map(f=>`本轮新增资料：${f.displayName}`)].join('\n');
    const inputIds = frozen.map(f=>f.id);
    await manager.query(`INSERT INTO task_revisions(id,task_id,revision_number,review_id,decision,message,upload_ids,input_ids,idempotency_key,effective_goal,previous_delivery)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[revisionId,taskId,revisionNumber,reviewId,body.decision,message,uploadIds,inputIds,key,effectiveGoal,JSON.stringify(previousDelivery)]);
    if (current) await manager.query('UPDATE task_acceptance_rounds SET decision=$2,decided_at=now() WHERE id=$1',[reviewId,body.decision]);
    await manager.query("UPDATE tasks SET state='planning',revision_number=$2,effective_goal=$3,updated_at=now() WHERE id=$1",[taskId,revisionNumber,effectiveGoal]);
    const kind = body.decision==='revise'?'human_revision_requested':'human_amendment_requested';
    const detail = {revisionId,revisionNumber,reviewId,attachmentCount:frozen.length,inputIds};
    await manager.query(`INSERT INTO task_activity_events(task_id,kind,state,message,detail,source)
      VALUES($1,$2,'planning',$3,$4::jsonb,'control_plane')`,[taskId,kind,`已收到第 ${revisionNumber} 次${title}，正在重新编排。`,JSON.stringify(detail)]);
    await manager.query('INSERT INTO audit_events(actor,action,payload) VALUES($1,$2,$3::jsonb)',
      ['administrator','task.'+kind,JSON.stringify({taskId,...detail})]);
    const receipt: RevisionReceipt = {taskId,state:'planning',decision:body.decision,revisionNumber,revisionId,reviewId,inputIds};
    return {receipt,enqueue:true};
  });
  if (enqueue) orchestration.enqueueRevision(taskId,receipt.revisionNumber);
  return receipt;
}
