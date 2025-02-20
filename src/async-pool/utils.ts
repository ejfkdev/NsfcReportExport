import { PromiseKit, XPromiseConfig } from "./type";

/**
 * 把传入的方法包装成异步执行
 * @param f
 */
export const AsyncRun = async (
    f: Function | null | undefined,
    ...args: any[]
) => await f?.(...args);

/**
 * 把传入的方法包装成异步执行，忽略异常
 * @param f
 */
export const AsyncRunIgnoreError = async (
    f: Function | null | undefined,
    ...args: any[]
) => {
    try {
        return await f?.(...args).catch(() => {});
    } catch {
        // 忽略错误，返回undefined
        return;
    }
};

/**
 * Promise.withResolvers polyfill
 * @returns `{ resolve, reject, promise }`
 */
export const withResolvers = <T = any>(fn?: any) => {
    let a: (value?: T | PromiseLike<T>) => void, b: (reason?: any) => void;
    let promise = new Promise<T>((resolve, reject) => {
        // @ts-ignore
        a = resolve;
        b = reject;
    });
    if (isExecutable(fn)) {
        // @ts-ignore
        promise = promise.then(fn).catch(() => {});
    }
    // @ts-ignore
    return { resolve: a, reject: b, promise };
};

/**
 * 阻塞和放行
 * @returns [promise, resolve]
 */
export const Wait = <T = any | void>(
    fn?: any,
): [Promise<T | void>, (value?: T | PromiseLike<T>) => void] => {
    const { promise, resolve } = withResolvers<T>(fn);
    return [promise, resolve];
};

/**
 * 阻塞、放行、拒绝
 * @returns [promise, resolve, reject]
 */
export const Wait3 = <T = any>(
    fn?: any,
): [
    Promise<T | void>,
    (value?: T | PromiseLike<T>) => void,
    (reason?: any) => void,
] => {
    const { promise, resolve, reject } = withResolvers<T>(fn);
    return [promise, resolve, reject];
};

/**
 * 阻塞和放行，超时后直接放行
 * @param timeout 超时毫秒
 * @returns [promise, resolve]
 */
export const WaitTimeout = <T = any>(
    timeout: number = 60 * 1000,
    fn?: any,
): [Promise<T | void>, (value?: T | PromiseLike<T>) => void] => {
    const { promise, resolve } = withResolvers<T>(fn);
    timeout = timeout > 2_147_483_647 ? 2_147_483_647 : timeout;
    timeout = timeout < 0 ? 0 : timeout;
    setTimeout(resolve);
    return [promise, resolve];
};

/**
 * 带有延迟防抖的Promise，在防抖时间内重复resolve会重新计时
 *
 * timeout为总超时计时，调用`WaitDelay()`后立即开始计时，到期后会强行resolve
 *
 * @param ms 防抖延迟毫秒
 * @param timeout 最大等待时长，超过后直接resolve，可被`cancel()`刷新计时，timeout必须大于防抖ms才会生效
 * @returns [pend, done, cancel]
 */
export const WaitDelay = (
    ms: number = 0,
    timeout: number = -1,
): [
    Promise<void>,
    (value?: void | PromiseLike<void>) => void,
    (action?: string) => void,
] => {
    ms = ms > 0 ? ms : 0;
    timeout = timeout > 2_147_483_647 ? 2_147_483_647 : timeout;
    const [pend, resolve] = Wait();
    let pending = false;
    let t1: any = null;
    let t2: any = null;

    /**
     * 启动带有防抖的resolve，计时到期后会执行resolve，完结promise
     *
     * 在延迟时间内再次执行`done()`，会重置计时
     */
    let done = () => {
        cancel();
        t1 = setTimeout(resolve, ms);
        // 只有处于pend状态，才会尝试刷新总超时
        if (pending && t2 == null && timeout >= ms) {
            t2 = setTimeout(resolve, timeout);
        }
    };

    /**
     * 取消执行`done`的防抖计时，如果action!='done'，还会一并取消总超时
     *
     * 对于总超时取消后，需要再次执行`pend()`或`done()`，才会重新计时
     * @param action 默认为空
     */
    let cancel = (action?: string) => {
        clearTimeout(t1);
        t1 = null;
        if (action != "done") {
            // 不等于done，会重新计时
            clearTimeout(t2);
            t2 = null;
        }
    };

    if (t2 == null && timeout >= ms) {
        t2 = setTimeout(resolve, timeout);
    }
    return [pend, done, cancel];
};

/**
 * 带有延迟防抖的Promise，在防抖时间内重复resolve会重新计时
 *
 * 还有总超时时间，超时后立刻resolve
 *
 * 与`WaitDelay`不同之处在于，返回的pend是一个方法，只有调用`pend()`后才开始总超时计时
 * @param ms 防抖延迟毫秒
 * @returns [promise, pend, done, reset]
 */
export const WaitDelayPend = (
    ms: number = 0,
    onfulfilled?: ((value: any) => void | PromiseLike<void>) | null,
): [
    Promise<void>,
    () => Promise<void>,
    (value?: void | PromiseLike<void>) => void,
    (action?: string) => void,
] => {
    ms = ms < 0 ? 0 : ms;
    ms = ms > 2_147_483_647 ? 2_147_483_647 : ms;
    let [promise, resolve] = Wait(onfulfilled);
    let tick: any = null;

    /**
     * 启动带有防抖的resolve，计时到期后会执行resolve，完结promise
     *
     * 在延迟时间内再次执行`done()`，会重置计时
     */
    let done = () => {
        clearTimeout(tick);
        resolve();
    };

    /**
     * 取消执行`done`的防抖计时，如果action!='done'，还会一并取消总超时
     *
     * 对于总超时取消后，需要再次执行`pend()`或`done()`，才会重新计时
     * @param action 默认为空
     */
    let reset = () => {
        clearTimeout(tick);
    };

    // 只有pend后，才会启动总超时计时
    const pend = () => {
        reset();
        tick = setTimeout(() => {
            resolve();
        }, ms);
        return promise;
    };

    // 第一个参数是promis对象，第二个是启动计时，第三个是直接完成，第四个是重置计时
    return [promise, pend, done, reset];
};

/**
 * 返回一个睡眠一段时间的promise
 * @param ms 睡眠毫秒
 * @returns
 */
export const sleep = (ms: number) => {
    const [promise, resolve] = Wait();
    setTimeout(resolve, ms);
    return promise;
};

/**
 * 判断传入的数据没有值，为null或者为undefined，返回true
 * @param any
 * @returns
 */
export const None = (any: any | null | undefined) => {
    return any == null || any == undefined;
};

/**
 * 判断传入的数据有值，不为null也不为undefined，返回true
 * @param any
 * @returns boolean
 */
export const NotNone = (any: any | null | undefined) => {
    return any != null && any != undefined;
};

/**
 * 判断对象是否是可执行的
 * @param obj 方法
 * @returns
 */
export const isExecutable = (obj: any) => {
    // 检查是否为普通函数或async函数
    if (typeof obj === "function") {
        return true;
    }

    // 检查是否为生成器函数
    const GeneratorFunction = function* () {}.constructor;
    if (obj instanceof GeneratorFunction) {
        return true;
    }

    // 检查是否为Promise
    if (obj instanceof Promise) {
        return true;
    }

    if (obj?.constructor?.name === "AsyncFunction") {
        return true;
    }

    return false;
};

export const isAsyncExecutable = (obj: any) => {
    // 检查是否为生成器函数
    const GeneratorFunction = function* () {}.constructor;
    if (obj instanceof GeneratorFunction) {
        return true;
    }

    // 检查是否为Promise
    if (obj instanceof Promise) {
        return true;
    }

    if (obj?.constructor?.name === "AsyncFunction") {
        return true;
    }

    return false;
};

export const GetPromiseKit = (fn?: any): PromiseKit => {
    const { resolve, reject, promise } = withResolvers(fn);
    return {
        Promise: promise,
        Resolve: resolve,
        Reject: reject,
    };
};

export enum PromiseState {
    pending = "pending",
    fulfilled = "fulfilled",
    rejected = "rejected",
}

export enum PromiseResult {
    fulfilled = 0x1,
    resolved = 0x10,
    rejected = 0x100,
    timeout = 0x1000,
    manual = 0x10000,
    debounce = 0x100000,
    abort = 0x1000000,
}

/**
 * 创建一个防抖函数，在指定延迟时间内多次调用只会执行最后一次。
 *
 * @template T 原始函数类型
 * @param {T} func 需要防抖的函数
 * @param {number} delay 防抖延迟时间（毫秒）
 * @returns {T} 返回防抖处理后的函数
 *
 * @example
 * ```typescript
 * const handler = (text: string) => console.log(text);
 * const debouncedHandler = debounce(handler, 300);
 *
 * // 多次调用，只有最后一次会执行
 * debouncedHandler("test1"); // 不会执行
 * debouncedHandler("test2"); // 不会执行
 * debouncedHandler("test3"); // 300ms 后执行
 * ```
 */
export const debounce = <T extends (...args: any[]) => any>(
    func: T,
    delay: number,
): T => {
    const [debouncedFn] = debounceWithCancel(func, delay);
    return debouncedFn;
};

/**
 * 创建一个带有取消功能的防抖函数，在指定延迟时间内多次调用只会执行最后一次，
 * 同时提供取消等待执行的能力。
 *
 * @template T 原始函数类型
 * @param {T} func 需要防抖的函数
 * @param {number} delay 防抖延迟时间（毫秒）
 * @returns {[T, () => void]} 返回一个元组，包含防抖处理后的函数和取消执行的函数
 *
 * @example
 * ```typescript
 * const handler = (text: string) => console.log(text);
 * const [debouncedHandler, cancel] = debounceWithCancel(handler, 300);
 *
 * debouncedHandler("test1"); // 开始计时
 * debouncedHandler("test2"); // 重置计时
 * cancel(); // 取消等待的执行
 *
 * // 取消后重新调用
 * debouncedHandler("test3"); // 300ms 后执行
 * ```
 */
export const debounceWithCancel = <T extends (...args: any[]) => any>(
    func: T,
    delay: number,
): [T, () => void] => {
    let timer: ReturnType<typeof setTimeout> | string | number | null = null;

    const cancel = () => {
        if (timer) {
            // @ts-ignore
            clearTimeout(timer);
            timer = null;
        }
    };

    const debouncedFn = function (
        this: any,
        ...args: Parameters<T>
    ): ReturnType<T> | void {
        cancel();
        timer = setTimeout(() => {
            func.apply(this, args);
            timer = null;
        }, delay);
    } as T;

    return [debouncedFn, cancel];
};

/**
 * XPromise类用于创建一个可配置的Promise对象，支持超时、取消和防抖功能。
 *
 * @class XPromise
 * @property {Promise<PromiseResult>} #promise - 内部Promise对象。
 * @property {(value: PromiseResult | PromiseLike<PromiseResult>) => void} #resolve - 用于解决Promise的方法。
 * @property {(value: PromiseResult | PromiseLike<PromiseResult>) => void} #resolveRaw - 原始解决Promise的方法。
 * @property {(reason: PromiseResult) => void} #reject - 用于拒绝Promise的方法。
 * @property {(value: PromiseResult | PromiseLike<PromiseResult>) => void} #debounceResolve - 带防抖功能的解决方法。
 * @property {XPromiseConfig} #config - 配置对象。
 * @property {NodeJS.Timeout | null} #timer - 定时器，用于处理超时。
 * @property {PromiseState} #state - 当前Promise的状态。
 *
 * @constructor
 * @param {XPromiseConfig} config - 配置对象，包含超时、取消和防抖等选项。
 *
 * @method timing - 启动定时器，根据配置处理超时。
 * @method cancelTiming - 取消定时器。
 *
 * @returns {XPromise} - 返回一个新的XPromise实例。
 */

export class XPromise {
    #promise: Promise<PromiseResult>;
    #resolve: (value?: PromiseResult) => void;
    #resolveRaw: (value?: PromiseResult) => void;
    #reject: (reason?: PromiseResult) => void;
    #debounceResolve: (
        value?: PromiseResult,
    ) => void;
    #config: XPromiseConfig;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #state = PromiseState.pending;
    constructor(config: XPromiseConfig) {
        this.#config = config = {
            timeout: 0,
            timeoutType: "resolve",
            debounce: 0,
            instantTiming: true,
            ...config,
        };
        //
        const { promise, resolve, reject } = withResolvers<PromiseResult>();
        this.#promise = promise;
        const _resolve = (
            value?: PromiseResult,
        ) => {
            this.#state = PromiseState.fulfilled;
            resolve(
                (value ?? 0) |
                    PromiseResult.manual | PromiseResult.resolved |
                    PromiseResult.fulfilled,
            );
        };
        const _reject = (reason?: PromiseResult) => {
            this.#state = PromiseState.rejected;
            reject(reason ?? PromiseResult.manual | PromiseResult.rejected);
        };
        this.#resolveRaw = _resolve;
        this.#resolve = _resolve;
        this.#reject = _reject;

        if (config.debounce && config.debounce > 0) {
            this.#resolve = this.#debounceResolve = debounce(() => {
                this.#resolveRaw(
                    PromiseResult.resolved | PromiseResult.fulfilled |
                        PromiseResult.debounce,
                );
            }, config.debounce);
        } else {
            this.#debounceResolve = this.#resolveRaw;
        }
        this.#reject = _reject;

        config.instantTiming && this.timing();
    }

    get promise() {
        if (!this.#timer && !this.#config.instantTiming) {
            this.timing();
        }
        return this.#promise;
    }

    /**
     * 获取当前Promise的状态
     */
    get state() {
        return this.#state;
    }

    /**
     * resolve方法，如果配置了debounce会有防抖
     */
    get resolve() {
        return this.#resolve;
    }

    /**
     * 原始的reject方法，会记录state
     */
    get reject() {
        return this.#reject;
    }

    /**
     * 防抖的resolve方法，如果设置了防抖时长会触发防抖逻辑
     */
    get debounceResolve() {
        return this.#debounceResolve;
    }

    /*
     * 原始的resolve方法，会记录state，不会触发防抖
     */
    get resolveRaw() {
        return this.#resolveRaw;
    }
    /**
     * 启动定时器，根据配置处理超时逻辑
     *
     * 如果设置了timeout且大于0，并且Promise状态为pending，则启动定时器
     * 定时器到期后根据timeoutType配置执行resolve或reject
     */
    timing() {
        // 超时候自动resolve
        if (
            (this.#config.timeout ?? 0) > 0 && this.#config.timeoutType &&
            this.#state === PromiseState.pending
        ) {
            this.cancelTiming();
            this.#timer = setTimeout(() => {
                if (this.#config.timeoutType === "resolve") {
                    // 超时后以resolve方式结束Promise
                    this.#resolve(
                        PromiseResult.timeout | PromiseResult.resolved |
                            PromiseResult.fulfilled,
                    );
                } else {
                    // 超时后以reject方式结束Promise
                    this.#reject(
                        PromiseResult.timeout | PromiseResult.rejected,
                    );
                }
                this.#timer = null;
            }, this.#config.timeout);
        }
    }

    /**
     * 取消当前的定时器
     * 清除timeout引用并将timer置为null
     */
    cancelTiming() {
        // @ts-ignore
        clearTimeout(this.#timer);
        this.#timer = null;
    }
}

/**
 * 创建一个新的XPromise实例
 *
 * @param {XPromiseConfig} config - XPromise的配置选项，包含timeout、timeoutType、debounce等配置
 * @returns {XPromise} 返回一个新的XPromise实例
 *
 * @example
 * ```typescript
 * // 创建一个基本的XPromise
 * const xp = GenXPromise();
 *
 * // 创建一个带超时的XPromise
 * const xpWithTimeout = GenXPromise({ timeout: 5000 });
 *
 * // 创建一个带防抖的XPromise
 * const xpWithDebounce = GenXPromise({ debounce: 300 });
 * ```
 */
export const GenXPromise = (config: XPromiseConfig = {}) =>
    new XPromise(config);
