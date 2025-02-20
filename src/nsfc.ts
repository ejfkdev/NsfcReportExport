import { imageDimensionsFromData } from "image-dimensions";
import { ImgResultType, ProjectInfo } from "./types";
import { fetchImageByProxyBatch, getCachedData, setCachedData } from "./utils";

const host = "https://kd.nsfc.cn";

/**
 * 获取一页报告图片
 * @param id 报告id
 * @param index 第几页
 * @returns ImgResultType
 */
export const getImgBlob = async (
    imgURL: string,
): Promise<ImgResultType> => {
    // 获取图片内容
    const imgArrayBuffer = await fetchImageByProxyBatch(imgURL);
    // 从图片内容解析宽高
    const size = imageDimensionsFromData(imgArrayBuffer);
    return {
        imageData: imgArrayBuffer,
        width: size?.width,
        height: size?.height,
        // pdf竖版或横版页
        orientation: (size?.width ?? 0) < (size?.height ?? 0) ? "p" : "l",
    };
};

export const getImgURL = async (
    id: string,
    index: number,
): Promise<[string, boolean]> => {
    let imgURL = "";
    const cacheData = await getCachedData(`img_${id}_${index}`);
    let cached = false;
    if (cacheData?.data) {
        imgURL = cacheData.data;
        cached = true;
    } else {
        const signal = AbortSignal.timeout(15000);
        const data = await fetch(
            `${host}/api/baseQuery/completeProjectReport`,
            {
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: `id=${id}&index=${index}`,
                method: "POST",
                signal,
            },
        ).then((response) => response.json());
        imgURL = host + data.data.url;
    }

    if (!cached) {
        const signal = AbortSignal.timeout(15000);
        // 检查图片URL是否可访问
        const response = await fetch(imgURL, {
            method: "HEAD",
            signal,
        });
        if (response.status === 404) {
            return ["404", cached];
        } else if (response.status !== 200) {
            throw new Error(`${response.status} ${imgURL}`);
        }
    }
    await setCachedData(`img_${id}_${index}`, imgURL, 60 * 60 * 24 * 7);
    return [imgURL, cached];
};

/**
 * 获取报告名称等基础信息
 * @param id
 * @returns
 */
export const getProjectInfo = async (id: string): Promise<ProjectInfo> => {
    console.log("getProjectInfo", id);
    const response = await fetch(
        `${host}/api/baseQuery/conclusionProjectInfo/${id}`,
        {
            headers: {
                accept: "application/json, text/plain, */*",
                "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                "content-type": "application/x-www-form-urlencoded",
            },
            body: null,
            method: "POST",
            mode: "cors",
        },
    );
    if (response.ok) {
        const data = await response.json();
        return {
            projectName: data?.data?.projectName ?? "projectName",
            projectAdmin: (data?.data?.projectAdmin ?? "") + " " +
                (data?.data?.dependUnit ?? ""),
            conclusionAbstract: data?.data?.conclusionAbstract ?? "",
            projectKeywordC: data?.data?.projectKeywordC ?? "",
        };
    } else {
        return {
            projectName: "projectName",
            projectAdmin: "",
            conclusionAbstract: "",
            projectKeywordC: "",
        };
    }
};
