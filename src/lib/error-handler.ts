import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";

/**
 * 即梦API错误响应接口
 */
export interface JimengErrorResponse {
  ret: string;
  errmsg: string;
  data?: any;
  historyId?: string;
}

/**
 * 错误处理选项
 */
export interface ErrorHandlerOptions {
  context?: string;
  historyId?: string;
  retryCount?: number;
  maxRetries?: number;
  operation?: string;
}

/**
 * 上游 `fail_code` 可读映射（P1-3）。
 *
 * 背景：此前失败只透出 `shark not pass reject (错误码: -6)` 这类不可读信息，
 * 定位 `fail_code=4013` 需要翻容器日志 —— 排查成本极高。本函数把它翻译成
 * **可读原因 + 建议动作**。
 *
 * 收录原则（**防编造**）：
 *  - 只收录**有实测锚点**的码，每条必须写明来源（日期 + 场景）；
 *  - 未收录的码返回空串（由调用方按原样打印原始码），**不做任何推测**；
 *  - 新增条目必须在来源栏附可复查证据，否则视为无效条目。
 *
 * | fail_code | 含义 | 建议动作 | 来源 |
 * |---|---|---|---|
 * | `4013` | 上游风控拒绝（账号维度或出口 IP 维度） | 换账号/换出口后**间隔 ≥30s** 重试；**禁止**同账号多 IP 快速轮试（封号风险） | 2026-09-18 Step 0 实测：JP 账号经住宅出口请求被拒，响应 `fail_code=4013`（见 `00_audit_report.md`） |
 */
function explainFailCode(failCode: string): string {
  switch (failCode) {
    case "4013":
      return "上游风控拒绝（该账号或该出口 IP 被判定为风险）"
        + "。建议动作：①换用其他账号，或更换出口 IP 后**间隔 ≥30 秒**再试；"
        + "②**切勿**对同一账号在多 IP 上快速轮试（有永久封号风险）；"
        + "③国际版账号可先改走国内（cn）通道验证是否为区域级风控。";
    default:
      return ""; // 未收录 → 不做推测，保留原始码由调用方打印
  }
}

/**
 * 统一的即梦API错误处理器
 */
export class JimengErrorHandler {
  
  /**
   * 处理即梦API响应错误
   */
  static handleApiResponse(
    response: JimengErrorResponse, 
    options: ErrorHandlerOptions = {}
  ): never {
    const { ret, errmsg, historyId } = response;
    const { context = '即梦API请求', operation = '操作' } = options;
    
    logger.error(`${context}失败: ret=${ret}, errmsg=${errmsg}${historyId ? `, historyId=${historyId}` : ''}`);
    
    // 根据错误码分类处理
    switch (ret) {
      case '1015':
        throw new APIException(EX.API_TOKEN_EXPIRES, `[登录失效]: ${errmsg}。请重新获取refresh_token并更新配置`);
      
      case '5000':
        throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, 
          `[积分不足]: ${errmsg}。建议：1)尝试使用1024x1024分辨率，2)检查是否需要购买积分，3)确认账户状态正常`);
      
      case '4001':
        throw new APIException(EX.API_CONTENT_FILTERED, `[内容违规]: ${errmsg}`);
      
      case '4002':
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `[参数错误]: ${errmsg}`);
      
      case '5001':
        throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `[生成失败]: ${errmsg}`);
      
      case '5002':
        throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `[视频生成失败]: ${errmsg}`);
      
      default: {
        // P1-3：尝试从 data 里提取上游 fail_code，补充可读原因（取不到则跳过，不做推测）
        const raw = response.data;
        const fc =
          raw && typeof raw === 'object'
            ? (raw.fail_code ?? raw.failCode ?? raw.fail_starling_key)
            : undefined;
        const hasFc = fc !== undefined && fc !== null;
        const explain = hasFc ? explainFailCode(String(fc)) : '';
        throw new APIException(
          EX.API_REQUEST_FAILED,
          `[${operation}失败]: ${errmsg} (错误码: ${ret}${hasFc ? `，fail_code: ${fc}` : ''})${explain ? `。${explain}` : ''}`
        );
      }
    }
  }
  
  /**
   * 处理网络请求错误
   */
  static handleNetworkError(
    error: any, 
    options: ErrorHandlerOptions = {}
  ): never {
    const { context = '网络请求', retryCount = 0, maxRetries = 3 } = options;
    
    logger.error(`${context}网络错误 (尝试 ${retryCount + 1}/${maxRetries + 1}): ${error.message}`);
    
    if (error.code === 'ECONNABORTED') {
      throw new APIException(EX.API_REQUEST_FAILED, `[请求超时]: ${context}超时，请稍后重试`);
    }
    
    if (error.code === 'ENOTFOUND') {
      throw new APIException(EX.API_REQUEST_FAILED, `[网络错误]: 无法连接到即梦服务器，请检查网络连接`);
    }
    
    if (error.response?.status >= 500) {
      throw new APIException(EX.API_REQUEST_FAILED, `[服务器错误]: 即梦服务器暂时不可用 (${error.response.status})`);
    }
    
    if (error.response?.status === 429) {
      throw new APIException(EX.API_REQUEST_FAILED, `[请求频率限制]: 请求过于频繁，请稍后重试`);
    }
    
    throw new APIException(EX.API_REQUEST_FAILED, `[${context}失败]: ${error.message}`);
  }

  /**
   * 处理轮询超时错误
   * @returns 如果有部分结果，返回 void 而不抛出异常
   */
  static handlePollingTimeout(
    pollCount: number,
    maxPollCount: number,
    elapsedTime: number,
    status: number,
    itemCount: number,
    historyId?: string
  ): void {
    const message = `轮询超时: 已轮询 ${pollCount} 次，耗时 ${elapsedTime} 秒，最终状态: ${status}，图片数量: ${itemCount}`;
    logger.warn(message + (historyId ? `，历史ID: ${historyId}` : ''));

    if (itemCount === 0) {
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED,
        `生成超时且无结果，状态码: ${status}${historyId ? `，历史ID: ${historyId}` : ''}`);
    }

    // 如果有部分结果，不抛出异常，让调用者处理
    logger.info(`轮询超时但已获得 ${itemCount} 张图片，将返回现有结果`);
  }
  
  /**
   * 处理生成失败错误
   * @param itemCount 已生成的结果数量，如果 > 0 则不抛出异常
   * @returns 如果有部分结果，返回 false 表示不应抛出异常
   */
  static handleGenerationFailure(
    status: number,
    failCode: string | undefined,
    historyId?: string,
    type: 'image' | 'video' = 'image',
    itemCount: number = 0
  ): boolean {
    const typeText = type === 'image' ? '图像' : '视频';
    const message = `${typeText}生成最终失败: status=${status}, failCode=${failCode}${historyId ? `, historyId=${historyId}` : ''}, 已生成数量=${itemCount}`;

    // 如果有部分结果，只记录警告，不抛出异常
    if (itemCount > 0) {
      logger.warn(message);
      logger.info(`${typeText}生成部分失败，但已获得 ${itemCount} 个结果，将返回现有结果`);
      return false; // 不抛出异常
    }

    // 没有任何结果时，记录错误并抛出异常
    logger.error(message);
    const exception = type === 'image' ? EX.API_IMAGE_GENERATION_FAILED : EX.API_VIDEO_GENERATION_FAILED;
    // P1-3：把上游 fail_code 翻译为可读原因 + 建议动作（未收录的码保持原样，不做推测）
    const explain = failCode ? explainFailCode(String(failCode)) : '';
    throw new APIException(
      exception,
      `${typeText}生成失败，状态码: ${status}${failCode ? `，错误码: ${failCode}` : ''}${explain ? `。${explain}` : ''}`
    );
  }
  
  /**
   * 包装重试逻辑的错误处理
   */
  static async withRetry<T>(
    operation: () => Promise<T>,
    options: ErrorHandlerOptions & { maxRetries?: number; retryDelay?: number } = {}
  ): Promise<T> {
    const { 
      maxRetries = 3, 
      retryDelay = 5000, 
      context = '操作',
      operation: operationName = '请求'
    } = options;
    
    let lastError: any;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        // 如果是APIException，直接抛出，不重试
        if (error instanceof APIException) {
          throw error;
        }
        
        if (attempt < maxRetries) {
          logger.warn(`${context}失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
          logger.info(`${retryDelay / 1000}秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    // 所有重试都失败了
    this.handleNetworkError(lastError, { 
      context, 
      retryCount: maxRetries, 
      maxRetries,
      operation: operationName
    });
  }
}

/**
 * 便捷的错误处理函数
 */
export const handleJimengError = JimengErrorHandler.handleApiResponse;
export const handleNetworkError = JimengErrorHandler.handleNetworkError;
export const handlePollingTimeout = JimengErrorHandler.handlePollingTimeout;
export const handleGenerationFailure = JimengErrorHandler.handleGenerationFailure;
export const withRetry = JimengErrorHandler.withRetry;
