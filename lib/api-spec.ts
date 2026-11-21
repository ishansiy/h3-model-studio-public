import { GENERATION_TYPES } from './generation-inputs';
import { MODEL_CATALOG } from './model-catalog';
import { HYPERFLOW_10S_PRESET,HYPERFLOW_FAST_PRESET } from './hyperflow-config';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, example?: unknown) => ({
  'application/json': example === undefined ? { schema } : { schema, example },
});
const header = (description: string, type = 'string') => ({ description, schema: { type } });
const traceHeaders = { 'X-Request-Id': header('请求追踪标识。排查问题时提供这个值。') };

function response(description: string, schema: string, example?: unknown, headers = {}) {
  return { description, headers: { ...traceHeaders, ...headers }, content: json(ref(schema), example) };
}
function error(description: string, code: string, message: string, headers = {}) {
  return response(description, 'Error', { error: message, code }, headers);
}

const unauthorized = error('密钥缺失、无效、过期或已撤销。', 'invalid_api_key', '请使用工作室 API 密钥作为 Bearer Token。');
const forbidden = error('密钥缺少该接口所需权限。', 'insufficient_scope', '此 API 密钥缺少所需权限。');
const rateLimited = error('同一个密钥每分钟最多 20 次请求。', 'rate_limited', '请求过于频繁。', {
  'Retry-After': header('再次请求前等待的秒数。', 'integer'),
});
const unavailable = error('工作室尚未配置或作品存储暂不可用。', 'upstream_error', '服务暂时不可用。');
const invalidType = error('提交的请求体必须使用 application/json。', 'invalid_content_type', '请使用 application/json。');
const tooLarge = error('请求体超过该接口的字节上限。', 'body_too_large', '请求内容过大。');
const taskMissing = error('找不到该工作室的任务。', 'not_found', '任务不存在。');
const invalidTask = error('请求字段、UUID、模型或参数组合不合法。', 'invalid_parameters', '请选择支持的生成参数。');
const conflict = error('请求 ID 已用于其他参数、暂无匹配账号、GPU 额度无法确认，或额度和会话时间预计不足。自动分配可返回 no_available_account、gpu_quota_unavailable 或 insufficient_gpu_time。', 'conflict', '请核对 requestId、模型和会话状态。');
const commonErrors = { '401': unauthorized, '403': forbidden, '429': rateLimited, '503': unavailable };

const jobId = '123e4567-e89b-42d3-a456-426614174000';
const accountId = '123e4567-e89b-42d3-a456-426614174001';
const videoExample = {
  requestId: jobId, category: 'video', modelId: 'hyperflow-h3-flash',
  prompt: '一只小黄鸭在水面缓缓漂浮。', width: 512, height: 288, duration: 5, steps: 4,
};
const fastVideoExample = {
  ...videoExample, requestId: '123e4567-e89b-42d3-a456-426614174003',
  width: HYPERFLOW_FAST_PRESET.width, height: HYPERFLOW_FAST_PRESET.height,
  duration: HYPERFLOW_FAST_PRESET.duration, steps: HYPERFLOW_FAST_PRESET.steps,
};
const longVideoExample = {
  ...fastVideoExample, requestId: '123e4567-e89b-42d3-a456-426614174005',
  duration: HYPERFLOW_10S_PRESET.duration,
};
const imageExample = {
  requestId: '123e4567-e89b-42d3-a456-426614174002', category: 'image', modelId: 'z-image-turbo',
  prompt: '阳光下的一只白色小猫。', width: 1024, height: 1024, steps: 9,
};
const accountExample = { id: accountId, name: '创作账户', username: 'example_user', hint: '…1234', created_at: 1795080000000 };
const { requestId: _requestId, ...sampleParams } = videoExample;
const job = {
  id: jobId, accountId, category: 'video', modelId: 'hyperflow-h3-flash', artifactMime: 'video/mp4',
  status: 'queued', stage: '等待会话处理', step: 0, totalSteps: 4,
  params: { ...sampleParams, mode: 'quality', runtimeProfile: 'standard', seed: '17047248144683748259' },
  createdAt: 1795080000000, updatedAt: 1795080000000, stopRequestedAt: null, error: null, metadata: null,
};
const id = { name: 'id', in: 'path', required: true, description: '任务 UUID，与提交时的 requestId 相同。', schema: { type: 'string', format: 'uuid' } };
const locationHeaders = { Location: header('相对任务查询路径，例如 /api/v1/jobs/{id}。') };
const contentHeaders = {
  'Accept-Ranges': header('支持的范围单位：bytes。'),
  'Content-Disposition': header('download=1 返回附件文件名，省略时以内联方式返回。'),
  'Content-Length': header('此次响应的字节数。', 'integer'),
};
const media = {
  'image/png': { schema: { type: 'string', format: 'binary' } },
  'video/mp4': { schema: { type: 'string', format: 'binary' } },
};
const inputId = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'POST /api/v1/inputs 返回的素材 ID。' };
const uploadImage = { schema: { type: 'string', format: 'binary' } };
const sizeRule = '宽、高使用模型目录 resolutions 中的配对尺寸，单位像素。省略时使用模型默认值。';

export const API_SPEC = {
  openapi: '3.1.0',
  info: {
    title: '模型工作室对外 API',
    version: '1.0.0',
    description: [
      'GET /api/v1/openapi.json 可直接读取规范。以下业务接口使用 Authorization: Bearer <工作室 API 密钥>。',
      '在 /integrations/keys 创建密钥，使用各接口的 x-required-scope 勾选权限。密钥有效期 90 天，每个密钥每分钟最多 20 次请求。',
      '典型流程：读取模型 → 生成小写 UUID → 提交 → 每 5–10 秒查询任务 → completed 后下载。提交超时先按原 UUID 查询，重试沿用同一 UUID 和参数。',
      '429 时按 Retry-After 等待。任务执行失败体现在 job.status=failed，并可查看 job.error。',
    ].join('\n\n'),
  },
  servers: [{ url: '/' }],
  security: [{ BearerAuth: [] }],
  tags: ['模型', '计算账户', '输入图片', '生成任务', '作品下载'].map(name => ({ name })),
  paths: {
    '/api/v1/models': {
      get: {
        operationId: 'listModels', tags: ['模型'], 'x-required-scope': 'models:read',
        summary: '查询可用模型、分辨率和默认参数',
        description: '返回 models 数组。创建前按 id 选择模型，并使用其 resolutions 和 defaults。',
        responses: { '200': response('模型目录。', 'ModelsResponse', { models: MODEL_CATALOG }), ...commonErrors },
      },
    },
    '/api/v1/accounts': {
      get: {
        operationId: 'listAccounts', tags: ['计算账户'], 'x-required-scope': 'accounts:read',
        summary: '查询已接入账户',
        description: '手动指定账户时，从 accounts[].id 取 accountId。响应只含账户标识、名称、用户名、密钥提示和接入时间。',
        responses: { '200': response('已接入账户列表。', 'AccountsResponse', { accounts: [accountExample] }), ...commonErrors },
      },
      post: {
        operationId: 'upsertAccount', tags: ['计算账户'], 'x-required-scope': 'accounts:write',
        summary: '接入或更新自己的 Kaggle 账户',
        description: '请求体最多 8 KiB。token 为该账户的 Kaggle API Token。用户名由 Kaggle 验证，同名账户更新后保留原 id。',
        requestBody: {
          required: true,
          content: json(ref('AccountRequest'), { name: '创作账户', token: 'KGAT_REPLACE_WITH_YOUR_TOKEN' }),
        },
        responses: {
          '200': response('已保存的账户。', 'AccountResponse', { account: accountExample }),
          '400': error('Token、用户名、名称或账户接入验证失败。', 'invalid_account', '请输入有效的 Kaggle API Token。'),
          '413': tooLarge, '415': invalidType, ...commonErrors,
        },
      },
    },
    '/api/v1/inputs': {
      post: {
        operationId: 'uploadInputImage', tags: ['输入图片'], 'x-required-scope': 'jobs:write',
        summary: '上传任务输入图片',
        description: '发送单帧图片的原始字节，最大 8 MiB。返回私有素材 ID，可用于首帧、尾帧、原图或蒙版。同一工作室可重复使用该 ID。',
        requestBody: { required: true, content: { 'image/png': uploadImage, 'image/jpeg': uploadImage, 'image/webp': uploadImage } },
        responses: {
          '201': response('已保存的输入图片。', 'InputImage', { id: 'a'.repeat(64), width: 1024, height: 768 }),
          '400': error('图片为空、损坏或无法完整解码。', 'invalid_image', '图片无法完整解码。'),
          '413': tooLarge,
          '415': error('只接受 PNG、JPEG 或 WebP。', 'unsupported_media_type', '请上传 PNG、JPEG 或 WebP 图片。'),
          ...commonErrors,
        },
      },
    },
    '/api/v1/jobs': {
      get: {
        operationId: 'listJobs', tags: ['生成任务'], 'x-required-scope': 'jobs:read',
        summary: '分页查询任务',
        description: '按创建时间倒序返回本地记录。用上一页 nextCursor 请求下一页，null 表示末页。',
        parameters: [
          { name: 'limit', in: 'query', description: '每页 1–100 条，默认 20。', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', description: '上次响应的 nextCursor。第一页省略。', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': response('当前页任务与下一页游标。', 'JobsResponse', { jobs: [job], nextCursor: null }),
          '400': error('页大小或游标无效。', 'invalid_pagination', 'limit 为 1–100，cursor 为上一页返回的任务 UUID。'),
          ...commonErrors,
        },
      },
      post: {
        operationId: 'createJob', tags: ['生成任务'], 'x-required-scope': 'jobs:write',
        summary: '提交图像或视频任务',
        description: '请求体最多 32 KiB。省略 accountId 时自动分配账号，将预计任务耗时和队列负载与 GPU 剩余额度及会话时限比较。requestId 由客户端生成。相同 ID 与参数可重试，相同 ID 改参数返回 409。seed 省略时由服务端分配，最终生效参数见 job.params。202 表示任务已受理，后续需查询状态。同账户同模型同运行方案可以复用 GPU 会话。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('GenerationRequest'),
              examples: {
                video: { summary: '生成视频', value: videoExample },
                hyperflowFast: { summary: 'HyperFlow 1024×768 双 T4 快档', value: fastVideoExample },
                hyperflow10s: { summary: 'HyperFlow 1024×768 双 T4 长片档（10 秒，实测约 1 小时 10 分钟）', value: longVideoExample },
                image: { summary: '生成图片', value: imageExample },
                keyframes: { summary: '用上传的首尾帧生成视频', value: {
                  ...videoExample, generationType: 'frames-to-video', firstFrame: 'a'.repeat(64), lastFrame: 'b'.repeat(64),
                } },
                editImage: { summary: '用蒙版重绘图片', value: {
                  ...imageExample, generationType: 'inpaint', sourceImage: 'a'.repeat(64), maskImage: 'b'.repeat(64), strength: 1,
                } },
              },
            },
          },
        },
        responses: {
          '200': response('复用已存在的任务。', 'JobSubmissionResponse', { job, replayed: true }, locationHeaders),
          '202': response('新任务已受理，使用 Location 或 job.id 查询。', 'JobSubmissionResponse', { job, replayed: false }, locationHeaders),
          '400': invalidTask,
          '404': error('未找到所选计算账户或引用的输入图片。', 'input_not_found', '找不到引用的输入图片，请重新上传。'),
          '409': conflict, '413': tooLarge, '415': invalidType, ...commonErrors,
        },
      },
    },
    '/api/v1/jobs/{id}': {
      get: {
        operationId: 'getJob', tags: ['生成任务'], 'x-required-scope': 'jobs:read',
        summary: '查询任务进度',
        description: '建议每 5–10 秒查询一次。本接口读取工作室已记录的状态。completed、failed、cancelled 为终态。生成失败时查看 job.error。',
        parameters: [id],
        responses: { '200': response('任务最新记录。', 'JobResponse', { job }), '404': taskMissing, ...commonErrors },
      },
    },
    '/api/v1/jobs/{id}/sync': {
      post: {
        operationId: 'syncJob', tags: ['生成任务'], 'x-required-scope': 'jobs:read',
        summary: '核对远端任务状态',
        description: '无需请求体。进度长时间不更新或 GPU 心跳中断时使用。例行轮询使用 GET。返回的是核对后当前保存的任务记录。',
        parameters: [id],
        responses: { '200': response('核对后的任务记录。', 'JobResponse', { job }), '400': invalidTask, '404': taskMissing, ...commonErrors },
      },
    },
    '/api/v1/jobs/{id}/cancel': {
      post: {
        operationId: 'cancelJob', tags: ['生成任务'], 'x-required-scope': 'jobs:write',
        summary: '请求取消任务',
        description: '无需请求体。等待中的任务通常可以立即取消。收到 202 后继续 GET 查询，job.status=cancelled 时确认。连续会话中的其他任务可继续排队。',
        parameters: [id],
        responses: {
          '200': response('返回当前任务记录，包括立即取消和部分既有终态。', 'JobResponse', { job: { ...job, status: 'cancelled', stage: '已取消排队' } }),
          '202': response('取消请求已受理，请继续查询。', 'JobResponse', { job: { ...job, status: 'running', stopRequestedAt: 1795080001000 } }),
          '400': invalidTask, '404': taskMissing, '409': conflict, ...commonErrors,
        },
      },
    },
    '/api/v1/jobs/{id}/artifact': {
      get: {
        operationId: 'downloadArtifact', tags: ['作品下载'], 'x-required-scope': 'jobs:read',
        summary: '读取或下载实际图片／视频',
        description: '任务 completed 后读取二进制内容。根据 Content-Type 保存为 PNG 或 MP4。客户端可用 Range 读取或续传当前工作室保存的作品。',
        parameters: [
          id,
          { name: 'download', in: 'query', description: '传 1 时按附件下载，默认内联。', schema: { type: 'string', enum: ['1'] } },
          { name: 'Range', in: 'header', description: '可选的单段字节范围，例如 bytes=0-1023。', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '完整 PNG 或 MP4 文件。', headers: { ...traceHeaders, ...contentHeaders }, content: media },
          '206': { description: '请求范围内的文件字节。', headers: { ...traceHeaders, ...contentHeaders, 'Content-Range': header('返回的字节范围与文件总长度。') }, content: media },
          '404': error('任务不存在、尚未完成或作品文件不可用。', 'not_found', '作品尚未生成。'),
          '410': error('旧任务需要重新连接原 Kaggle 账户。', 'artifact_gone', '请重新连接该 Kaggle 账户以下载视频。'),
          '416': { description: '字节范围无效。', headers: { ...traceHeaders, 'Content-Range': header('格式为 bytes */总字节数。') } },
          '502': error('旧任务的远端文件暂时无法读取。', 'upstream_error', '视频读取失败，请稍后重试。'),
          ...commonErrors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'H3AK', description: '工作室 API 密钥，不是站点密码或 Kaggle Token。' },
    },
    schemas: {
      Error: { type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string' } } },
      ModelsResponse: {
        type: 'object', required: ['models'],
        properties: { models: { type: 'array', items: ref('Model') } },
      },
      Model: {
        type: 'object', required: ['id', 'category', 'name', 'resolutions', 'defaults'],
        properties: {
          id: { type: 'string' }, category: { type: 'string', enum: ['video', 'image'] }, name: { type: 'string' },
          description: { type: 'string' },
          generationTypes: { type: 'array', items: { type: 'string', enum: Object.keys(GENERATION_TYPES) } },
          resolutions: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } } } },
          defaults: { type: 'object', description: '该模型的默认生成参数。' },
          fastPreset: ref('HyperFlowDualT4Preset'),
          dualT4Presets: {
            type: 'array', items: ref('HyperFlowDualT4Preset'),
            description: 'HyperFlow 已实测的双 T4 可选档。提交相应尺寸、时长和步数即可选择。10 秒档含环境和模型准备共约 1 小时 10 分钟。',
          },
        },
      },
      HyperFlowDualT4Preset: {
        type: 'object', required: ['width', 'height', 'duration', 'frames', 'steps', 'accelerator'],
        properties: {
          width: { type: 'integer' }, height: { type: 'integer' },
          duration: { type: 'number', description: '请求秒数。' },
          frames: { type: 'integer', description: '对齐后的输出帧数。' },
          steps: { type: 'integer' }, accelerator: { type: 'string', const: 'dual-t4' },
          measuredTotalSeconds: { type: 'integer', description: '实测 Notebook 总耗时（秒），包含环境准备和模型下载。' },
        },
      },
      AccountRequest: {
        type: 'object', additionalProperties: false, required: ['token'],
        properties: {
          token: { type: 'string', writeOnly: true, pattern: '^KGAT_[A-Za-z0-9_-]{16,512}$', description: '拟接入账户的 Kaggle API Token。' },
          name: { type: 'string', maxLength: 40, description: '显示名称。省略时由工作室填写。' },
          username: { type: 'string', pattern: '^[a-zA-Z0-9_-]{2,64}$', description: '可选。填写时必须与 Kaggle 验证出的用户名一致。' },
        },
      },
      ConnectedAccount: {
        type: 'object', required: ['id', 'name', 'username', 'hint', 'created_at'],
        properties: {
          id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, username: { type: 'string' },
          hint: { type: 'string' }, created_at: { type: 'integer', description: 'Unix 毫秒。' },
        },
      },
      AccountsResponse: { type: 'object', required: ['accounts'], properties: { accounts: { type: 'array', items: ref('ConnectedAccount') } } },
      AccountResponse: { type: 'object', required: ['account'], properties: { account: ref('ConnectedAccount') } },
      JobsResponse: {
        type: 'object', required: ['jobs', 'nextCursor'],
        properties: { jobs: { type: 'array', items: ref('Job') }, nextCursor: { type: ['string', 'null'], format: 'uuid' } },
      },
      InputImage: {
        type: 'object', required: ['id', 'width', 'height'],
        properties: { id: inputId, width: { type: 'integer' }, height: { type: 'integer' } },
      },
      GenerationRequest: {
        type: 'object', additionalProperties: false, required: ['requestId', 'prompt'],
        properties: {
          requestId: { type: 'string', format: 'uuid', description: '客户端生成的小写 UUID。同一业务请求重试沿用该值。' },
          accountId: { type: 'string', format: 'uuid', description: '可省略，由工作室自动分配。指定时使用 GET /api/v1/accounts 返回的 id。' },
          category: { type: 'string', enum: ['video', 'image'], description: '省略时从模型推断。category=image 且省略模型时默认 z-image-turbo。' },
          modelId: { type: 'string', enum: ['h3', 'hyperflow-h3-flash', 'z-image-turbo'], description: '必须与类别匹配。省略时视频默认 h3。' },
          prompt: { type: 'string', minLength: 1, maxLength: 6000, description: '视频最多 6000 字符，图片最多 3000 字符。' },
          width: { type: 'integer', description: sizeRule },
          height: { type: 'integer', description: sizeRule },
          generationType: { type: 'string', enum: Object.keys(GENERATION_TYPES), description: '省略时使用该类别的文生方式。两款视频模型支持首帧和首尾帧，Z-Image-Turbo 支持图生图和局部重绘。' },
          firstFrame: { ...inputId, description: '首帧图生视频和首尾帧视频必填。' },
          lastFrame: { ...inputId, description: '首尾帧视频必填。' },
          sourceImage: { ...inputId, description: '图生图像和局部重绘必填。' },
          maskImage: { ...inputId, description: '局部重绘必填，与原图同尺寸，白色区域重绘。' },
          strength: { type: 'number', minimum: 0.2, maximum: 1, description: '重绘幅度。图生图默认 0.6，局部重绘默认 1。' },
          mode: { type: 'string', enum: ['quality', 'turbo'], description: 'H3 原版默认 quality。HyperFlow 只支持 quality，图片省略。' },
          duration: { type: 'number', minimum: 4, maximum: 15, description: '请求视频秒数。H3 为 4–15 秒，1024×768 上限 4.46 秒，HyperFlow 为 5–15 秒。图片省略。帧数对齐后实际时长可能略长。' },
          steps: { type: 'integer', minimum: 1, maximum: 50, description: 'H3 原版 1–50（默认 20）、H3 Turbo 4 或 8（默认 8）、HyperFlow 4／6／8（默认 6）、Z-Image 固定 9。HyperFlow 的 1024×768、4 步支持双 T4 快档（duration=5，124 帧）和长片档（duration=10，243 帧，实测含环境和模型准备约 1 小时 10 分钟）。' },
          runtimeProfile: { type: 'string', enum: ['standard', 'fp16', 'ck'], description: '默认 standard。fp16 仅 H3 原版，HyperFlow 和 Z-Image 仅 standard。' },
          seed: { oneOf: [{ type: 'string', pattern: '^[0-9]{1,20}$' }, { type: 'integer', minimum: 0, maximum: 9007199254740991 }], description: '省略时随机分配。范围 0–18446744073709551615，超过 JavaScript 安全整数时使用十进制字符串。' },
        },
      },
      JobSubmissionResponse: { type: 'object', required: ['job', 'replayed'], properties: { job: ref('Job'), replayed: { type: 'boolean' } } },
      JobResponse: { type: 'object', required: ['job'], properties: { job: ref('Job') } },
      Job: {
        type: 'object', required: ['id', 'status', 'params', 'step', 'totalSteps'],
        properties: {
          id: { type: 'string', format: 'uuid' }, accountId: { type: 'string', format: 'uuid' },
          category: { type: 'string', enum: ['video', 'image'] }, modelId: { type: 'string' },
          artifactMime: { type: 'string', enum: ['video/mp4', 'image/png'] },
          status: { type: 'string', enum: ['submitting', 'submission_unknown', 'queued', 'running', 'completed', 'failed', 'cancelled'] },
          params: { type: 'object', description: '实际执行的参数和种子。' },
          stage: { type: 'string' }, step: { type: 'integer' }, totalSteps: { type: 'integer' },
          stopRequestedAt: { type: ['integer', 'null'] }, error: { type: ['string', 'null'] }, metadata: { type: ['object', 'null'], description: '成功的双 T4 快档任务可在 hyperflow_precision_proof.head_parallel 查到实际调用次数 calls 和参与设备 devices。' },
          createdAt: { type: 'integer', description: 'Unix 毫秒。' }, updatedAt: { type: 'integer', description: 'Unix 毫秒。' },
        },
      },
    },
  },
};
