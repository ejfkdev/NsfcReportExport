export type ImgResultType = {
    index?: number;
    imageData: Uint8Array;
    width: any;
    height: any;
    orientation: "p" | "l" | "portrait" | "landscape" | undefined;
};

export type ToastMsg = {
    type?: "show" | "done";
    title: string;
    message: string;
};

export type ProjectInfo = {
    projectName: string;
    projectAdmin: string;
    conclusionAbstract: string;
    projectKeywordC: string;
};

export type CacheData = {
    data: any;
    expire: number;
};

export type Getter<T> = () => T;
export type Setter<T> = (v: T) => T | void;

export type GetterSetter<T> = [
    getter: Getter<T>,
    setter: Setter<T>,
];
