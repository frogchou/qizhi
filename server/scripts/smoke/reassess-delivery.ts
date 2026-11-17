import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskActivityPublisher,TaskActivityService } from '../../apps/control-plane/src/observability/task-activity.service';
import { TaskSessionService } from '../../apps/control-plane/src/tasks/task-session.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { TaskSchedulerService } from '../../apps/control-plane/src/tasks/task-scheduler.service';

async function main() {
  const taskId=process.argv[2];
  if(!taskId || !process.env.DATABASE_URL) throw new Error('Supply exactly one legacy task ID and DATABASE_URL');
  const db=createControlPlaneDataSource(process.env.DATABASE_URL);
  await db.initialize();
  try {
    const root='/home/middleground/data/workspaces';
    const ws=new TaskWorkspaceService({root});
    const disabled=async()=>{throw new Error('Reassessment cannot start or stop instances');};
    const scheduler=new TaskSchedulerService(db,ws,new TaskSessionService(ws),{startInstance:disabled,stopInstance:disabled},
      {workspaceRoot:root,callbackBaseUrl:'http://127.0.0.1:3010'},new TaskActivityService(db,new TaskActivityPublisher()));
    await scheduler.reassessAutomatic(taskId);
    console.log(await db.query('SELECT t.state,r.round,r.criteria,r.assessment->\'items\' AS items FROM tasks t JOIN task_acceptance_rounds r ON r.task_id=t.id WHERE t.id=$1',[taskId]));
  } finally {await db.destroy();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
