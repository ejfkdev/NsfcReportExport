import {
    AsyncRun,
    AsyncRunIgnoreError,
    GenXPromise,
    PromiseResult,
    PromiseState,
    XPromise,
} from "./utils";
import {
    AsyncPoolEvent,
    LastTaskResult,
    RetryConfig,
    TaskItem,
    XPromiseConfig,
} from "./type";

class RetryError extends Error {}

export class AsyncPool<T = any, R = any> {
    config = {
        name: "default",
        parallel: 2,
        autoRun: true,
        autoRetry: false,
        retryCount: 3,
        retryDelay: 0,
        waitTime: 10000,
        queueCacheLength: 2,
    };
    #queue: TaskItem[] = [];
    running = false;
    #paralleCount = 0;
    #delayTaskCount = 0;
    callbacks: {
        oneTaskDone?: CallableFunction | null;
        limiter?: CallableFunction | null;
    } = {
        oneTaskDone: null,
        limiter: null,
    };

    get queueLength() {
        return this.#queue.length;
    }

    get delayTaskCount() {
        return this.#delayTaskCount;
    }

    constructor(options: {
        name?: string;
        parallel?: number;
        autoRun?: boolean;
        autoRetry?: boolean;
        retryCount?: number;
        retryDelay?: number;
        waitTime?: number;
        queueCacheLength?: number;
    } = {}) {
        // 基础配置初始化
        this.config.name = options.name ?? this.config.name;
        this.config.parallel = options.parallel ?? this.config.parallel;
        this.config.parallel = this.config.parallel < 1
            ? 1
            : this.config.parallel;
        this.config.autoRun = options.autoRun ?? this.config.autoRun;
        this.config.autoRetry = options.autoRetry ?? this.config.autoRetry ??
            false;

        // 重试相关配置
        this.config.retryCount = options.retryCount ?? this.config.retryCount;
        this.config.retryCount = this.config.retryCount < 0
            ? 0
            : this.config.retryCount;
        this.config.retryDelay = options.retryDelay ?? this.config.retryDelay;
        this.config.waitTime = options.waitTime ?? this.config.waitTime ?? 0;
        this.config.queueCacheLength = options.queueCacheLength ??
            this.config.parallel;
    }

    add(...items: TaskItem<T>[]) {
        for (const item of items) {
            const task: TaskItem = {
                worker: item.worker,
                args: item.args,
                config: {
                    autoRetry: this.config.autoRetry,
                    retryCount: this.config.retryCount,
                    retryDelay: this.config.retryDelay,
                    next: false,
                    ...item.config,
                },
                ctx: {
                    retryCount: item?.config?.retryCount ??
                        this.config.retryCount,
                    asyncpool: this,
                    signal: null,
                },
            };
            this.#queue.push(task);
        }
        this.#event.queueInc?.resolve();
        this.#event.queueNotZero?.resolve();
        this.config.autoRun && this.run();
    }

    #abortList: AbortController[] = [];

    #retry(
        retryConf: RetryConfig,
        task: TaskItem<T>,
    ) {
        if (!retryConf?.force && task.ctx!.retryCount <= 0) {
            const err = new RetryError("retryCount is 0");
            AsyncRunIgnoreError(this.callbacks?.oneTaskDone, null, err, task);
            return;
        }
        task.ctx!.retryCount--;
        let _delay = retryConf?.delay ?? task.config!.retryDelay ?? 0;
        if (_delay > 0) {
            this.#delayTaskCount++;
            setTimeout(() => {
                this.add(task);
                this.#delayTaskCount--;
            }, _delay);
        } else {
            this.add(task);
        }
    }

    lastTaskResult: LastTaskResult<T, R> = {};

    async #execute({
        task,
    }: {
        task: TaskItem;
    }) {
        if (!task) return;
        this.#paralleCount++;
        this.#event.taskStart?.resolve();

        let result: R | null | undefined = null,
            error: Error | null | undefined = null,
            retried = false;

        if (task?.config?.next) {
            // task.ctx.next = () => {
            // };
        }

        try {
            result = await AsyncRun(task.worker, ...(task?.args ?? []), task)
                .catch((err) => {
                    throw err;
                });
        } catch (err) {
            error = err as Error;
            if (
                task.config!.autoRetry &&
                task.ctx!.retryCount > 0
            ) {
                retried = true;
                task.ctx?.retry?.();
            }
        }

        this.lastTaskResult = { result, error, task };

        this.#paralleCount--;
        if (this.#paralleCount === 0) this.#event.parallelZero?.resolve();
        this.#event.parallelIdel?.resolve();
        this.#event.queueCacheIdel?.resolve();
        !retried &&
            AsyncRunIgnoreError(
                this.callbacks?.oneTaskDone,
                result,
                error,
                task,
            );
    }

    /**
     * 从队列中获取任务
     * @returns 如果队列不为空，返回队列中的第一个任务；否则返回undefined
     */
    async #getTask() {
        if (this.#queue.length > 0) {
            // 从队列头部取出一个任务
            const task = this.#queue.shift();
            // promise事件、回调
            // TODO：触发队列少一个事件
            // this.trigger(this.callbacks.queueDec)
            return task;
        }
    }

    tobeBreak() {
        this.#event.tobeBreak?.resolve(PromiseResult.abort);
    }

    /**
     * 获取下一个待执行的任务
     * @returns 返回任务或undefined
     */
    async #next() {
        // 当存在延迟任务时持续等待队列不为空的事件，防止timeout的影响
        while (this.#delayTaskCount > 0) {
            // 等待队列不为空的事件，如果需要中断则返回
            const result = await this.events.queueNotZero;
            if (result! & PromiseResult.timeout) continue;
            break;
        }

        // 等待队列不为空
        const waitQueue = await Promise.any([
            this.events.tobeBreak,
            this.events.queueNotZero,
        ]);
        if (await this.#waitOrBreak(waitQueue)) {
            return;
        }
        // 等待并行数量降低到限制以下
        if (await this.#waitOrBreak(this.events.parallelIdel)) {
            return;
        }
        // 从队列中获取任务
        const task = await this.#getTask();
        return task;
    }

    queueFilter(filter: (task: TaskItem) => boolean) {
        this.#queue = this.#queue.filter(filter);
    }

    async #limit() {
        await AsyncRunIgnoreError(
            this.callbacks.limiter,
            this,
        );
    }

    async run() {
        if (this.running && this.#queue.length > 0) return;
        this.running = true;
        let needBreak = false;
        this.#event.queueInc?.cancelTiming();
        let num = 0;
        this.#abortList = Array(this.config.parallel).fill(null).map((_) =>
            new AbortController()
        );
        let taskCount = 0;
        Loop:
        while (1) {
            if (this.#abortList[num].signal.aborted) {
                this.#abortList[num] = new AbortController();
            }

            const task = await this.#next();
            if (!task) {
                break Loop;
            }
            task.ctx!.signal = this.#abortList[num].signal;
            task.ctx!.retry = (conf?: RetryConfig) => this.#retry(conf, task);

            this.#execute({
                task,
            }).then(() => {
                taskCount++;
            });

            // 修改这里：确保 num 不会超出并行度
            num = (num + 1) % this.config.parallel;

            await this.#limit();
        }

        this.running && await this.stop({ abort: false });
        // 触发事件和回调
        if (taskCount > 0) {
            this.#event.allTaskDone?.resolve();
            this.#event.allTaskDoneWithDebounce?.resolve();
            !needBreak && this.#event.allTaskDoneNotBreak?.resolve();
        }
    }

    async #waitOrBreak(p?: Promise<PromiseResult> | PromiseResult) {
        const result = await p ?? 0;
        return Boolean(result & PromiseResult.abort) ||
            Boolean(result & PromiseResult.rejected) ||
            Boolean(result & PromiseResult.timeout);
    }

    #event: AsyncPoolEvent = {
        queueInc: null,
        queueNotZero: null,
        queueZero: null,
        allTaskDone: null,
        allTaskDoneWithDebounce: null,
        allTaskDoneNotBreak: null,
        parallelIdel: null,
        oneWorkerDone: null,
        queueCacheIdel: null,
        taskStart: null,
        tobeBreak: null,
    };

    #currentEvent: XPromise | null | undefined = null;

    #getEventPromise(eventName: keyof AsyncPoolEvent, config?: XPromiseConfig) {
        this.#currentEvent = this.#event[eventName];
        if (this.#currentEvent?.state === PromiseState.pending) {
            return this.#currentEvent?.promise;
        }
        this.#currentEvent = this.#event[eventName] = GenXPromise(config);
        return this.#event[eventName]?.promise;
    }

    events = Object.defineProperties({}, {
        queueInc: {
            get: () =>
                this.#getEventPromise("queueInc") ||
                PromiseResult.resolved | PromiseResult.fulfilled,
        },
        queueNotZero: {
            get: () =>
                // 如果队列为空，开始等待，如果不为空，直接通过返回resolved
                this.#queue.length == 0 &&
                    this.#getEventPromise("queueNotZero", {
                        timeout: this.config.waitTime,
                    }) ||
                PromiseResult.resolved | PromiseResult.fulfilled,
        },
        parallelIdel: {
            get: () => {
                return this.#paralleCount >= this.config.parallel &&
                        this.#getEventPromise("parallelIdel") ||
                    PromiseResult.resolved | PromiseResult.fulfilled;
            },
        },
        parallelZero: {
            get: () =>
                this.#paralleCount != 0 &&
                    this.#getEventPromise("parallelZero") ||
                PromiseResult.resolved | PromiseResult.fulfilled,
        },
        allTaskDone: {
            get: () =>
                this.#queue.length != 0 &&
                    this.#paralleCount != 0 &&
                    this.#getEventPromise("allTaskDone") ||
                PromiseResult.resolved | PromiseResult.fulfilled,
        },
        queueCacheIdel: {
            get: () => {
                // 缓存长度 = queue队列 + 正在运行的任务
                // 正在运行 + 队列长度 >= 缓存限额数量 需要等待
                return this.#paralleCount + this.#queue.length >=
                                this.config.queueCacheLength &&
                        this.#getEventPromise("queueCacheIdel", {
                            debounce: this.config.waitTime,
                        }) || PromiseResult.resolved | PromiseResult.fulfilled;
            },
        },
        taskStart: {
            get: () =>
                this.#getEventPromise("taskStart") ||
                PromiseResult.resolved | PromiseResult.fulfilled,
        },
        tobeBreak: {
            get: () => this.#getEventPromise("tobeBreak"),
        },
    }) as {
        queueInc?: Promise<PromiseResult>;
        queueNotZero?: Promise<PromiseResult>;
        parallelIdel?: Promise<PromiseResult>;
        parallelZero?: Promise<PromiseResult>;
        allTaskDone?: Promise<PromiseResult>;
        queueCacheIdel?: Promise<PromiseResult>;
        taskStart?: Promise<PromiseResult>;
        tobeBreak?: Promise<PromiseResult>;
    };

    async stop({
        // 对正在运行的任务发送abort信号
        abort,
    }: {
        abort?: boolean;
    }) {
        this.running = false;
        this.#currentEvent?.resolve(PromiseResult.abort);
        abort && this.#abortList.forEach((abort) => {
            abort.abort();
        });
        return await this.events.parallelZero;
    }

    clear() {
        this.#queue = [];
        this.#delayTaskCount = 0;
        this.#currentEvent = null;
        this.#abortList = [];
    }
}
