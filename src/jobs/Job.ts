import { Result } from "../models/Result";
import { Task } from "../models/Task";


export interface Job {
    run(task: Task, dependencyTaskResult?: Result | null): Promise<any>;
}