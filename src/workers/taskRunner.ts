import { Repository } from 'typeorm';
import { Task } from '../models/Task';
import { getJobForTaskType } from '../jobs/JobFactory';
import { WorkflowStatus } from "../workflows/WorkflowFactory";
import { Workflow } from "../models/Workflow";
import { Result } from "../models/Result";

export enum TaskStatus {
    Queued = 'queued',
    InProgress = 'in_progress',
    Completed = 'completed',
    Failed = 'failed'
}

export class TaskRunner {
    constructor(
        private taskRepository: Repository<Task>,
    ) { }

    /**
     * Runs the appropriate job based on the task's type, managing the task's status.
     * @param task - The task entity that determines which job to run.
     * @throws If the job fails, it rethrows the error.
     */
    async run(task: Task): Promise<void> {
        task.status = TaskStatus.InProgress;
        task.progress = 'starting job...';
        await this.taskRepository.save(task);

        const job = getJobForTaskType(task.taskType);
        const resultRepository = this.taskRepository.manager.getRepository(Result);

        try {
            console.log(`Starting job ${task.taskType} for task ${task.taskId}...`);

            let dependencyResult: Result | null = null;
            if (task.dependency) {
                dependencyResult = await resultRepository.findOne({
                    where: { taskId: task.dependency.taskId },
                });
            }

            const taskOutput = await job.run(task, dependencyResult);
            console.log(`Job ${task.taskType} for task ${task.taskId} completed successfully.`);

            const result = new Result();
            result.taskId = task.taskId!;
            result.data = JSON.stringify(taskOutput ?? {});
            await resultRepository.save(result);

            task.resultId = result.resultId!;
            task.status = TaskStatus.Completed;
            task.progress = null;
            await this.taskRepository.save(task);
        } catch (error: any) {
            console.error(`Error running job ${task.taskType} for task ${task.taskId}:`, error);

            task.status = TaskStatus.Failed;
            task.progress = null;
            await this.taskRepository.save(task);
            await this.failDependentTasks(task);

            throw error;
        } finally {
            await this.updateWorkflowStatus(task.workflow.workflowId);
        }
    }

    private async failDependentTasks(failedTask: Task): Promise<void> {
        const dependentTasks = await this.taskRepository.find({
            where: { dependency: { taskId: failedTask.taskId } },
        });

        for (const dependentTask of dependentTasks) {
            if (dependentTask.status === TaskStatus.Queued || dependentTask.status === TaskStatus.InProgress) {
                dependentTask.status = TaskStatus.Failed;
                dependentTask.progress = null;
                await this.taskRepository.save(dependentTask);
                await this.failDependentTasks(dependentTask);
            }
        }
    }

    private async updateWorkflowStatus(workflowId: string): Promise<void> {
        const workflowRepository = this.taskRepository.manager.getRepository(Workflow);
        const workflow = await workflowRepository.findOne({
            where: { workflowId },
            relations: ['tasks'],
        });

        if (!workflow) {
            return;
        }

        const allCompleted = workflow.tasks.every(t => t.status === TaskStatus.Completed);
        const anyFailed = workflow.tasks.some(t => t.status === TaskStatus.Failed);

        if (anyFailed) {
            workflow.status = WorkflowStatus.Failed;
        } else if (allCompleted) {
            workflow.status = WorkflowStatus.Completed;
        } else {
            workflow.status = WorkflowStatus.InProgress;
        }

        await workflowRepository.save(workflow);
    }
}
