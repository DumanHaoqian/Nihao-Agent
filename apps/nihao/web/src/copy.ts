/** Languages supported by the interface; chat content follows the user's request. */
export type Locale = 'en' | 'zh';

const english = {
  brand: 'Nihao Agent',
  avatarLabel: 'Nihao travel companion',
  replyTable: 'Scrollable table',
  avatarVoiceIssue: 'Please check the voice input message below',
  tagline: 'A little local knowledge goes a long way',
  description: 'From your first nihao to your next adventure — ask about life, food, and travel in China',
  heading: 'China, a little closer',
  placeholder: 'Where will your curiosity take you?',
  followUpPlaceholder: 'Ask a follow-up question',
  inputLabel: 'Message Nihao Agent',
  send: 'Send message',
  stop: 'Stop response',
  newChat: 'New chat',
  language: 'Interface language',
  english: 'English',
  chinese: '中文',
  composerHint: 'Your journey starts with a question',
  keyboardHint: 'Shift + Enter for a new line',
  startVoiceInput: 'Start voice input',
  voiceInputHint: 'Voice input · English and Chinese',
  cancelVoiceInput: 'Cancel voice input',
  finishVoiceInput: 'Finish voice input',
  voicePermission: 'Allow microphone access…',
  voiceConnecting: 'Connecting…',
  voiceListening: 'Listening',
  voiceFinishing: 'Finishing…',
  voicePermissionDenied: 'Allow microphone access in your browser’s site settings, then try again',
  voicePermissionTimeout: 'Microphone access is still waiting. Allow access and tap the microphone again',
  voiceNoMicrophone: 'No microphone was found. Connect a microphone and try again',
  voiceMicrophoneBusy: 'The microphone could not start. Check your device settings and try again',
  voiceUnsupported: 'Voice input needs a browser with microphone support. Try current Chrome or Safari',
  voiceUnavailable: 'Voice input is unavailable right now. Please try again shortly',
  voiceNetworkError: 'Voice input could not connect. Check your connection and try again',
  voiceInterrupted: 'Voice input was interrupted. Any recognized text has been kept',
  voiceNoSpeech: 'No speech was recognized. Try again and speak a little closer to the microphone',
  voiceBusy: 'Voice input is busy. Please wait a moment and try again',
  voiceTooLong: 'Voice input reached its limit. Review the text before continuing',
  disclaimer: 'Nihao can make mistakes. Check important travel details',
  user: 'You',
  thinking: 'Finding the right words…',
  writing: 'Nihao is replying',
  stopped: 'Response stopped',
  copy: 'Copy response',
  copied: 'Copied',
  copyFailed: 'Could not copy. Select the text to copy it',
  readAloud: 'Read aloud',
  stopReading: 'Stop reading',
  replaySpeech: 'Replay',
  preparingSpeech: 'Preparing voice…',
  cancelPreparingSpeech: 'Preparing… · Cancel',
  readingSpeech: 'Reading this reply',
  speechUnavailable: 'Voice playback is unavailable right now. Please try again shortly',
  speechNetworkError: 'Could not load the voice. Check your connection and try again',
  speechInterrupted: 'The voice was interrupted. Please try again',
  speechTooLong: 'This reply is too long to read aloud. Try asking for a shorter answer',
  speechUnsupported: 'Audio playback is not supported in this browser. Try another browser',
  speechPlaybackBlocked: 'Audio could not start. Tap Read aloud to try again',
  speechBusy: 'Voice playback is busy. Please wait a moment and try again',
  retry: 'Try again',
  error: 'Something interrupted the reply. Please try again',
  networkError: 'Could not connect. Check your connection and try again',
  limitError: 'This conversation is getting long. Start a new chat to continue',
  unavailableError: 'Chat is temporarily unavailable. Please try again shortly',
  rateLimitError: 'Too many requests right now. Please wait a moment and try again',
  emptyError: 'No reply came through. Please try again',
  timeoutError: 'The reply took too long. Please try again',
  replyLimitError: 'The reply reached its length limit. Try asking a more specific question',
  invalidRequestError: 'This message could not be sent. Try a shorter message',
  travelFindingPlaces: 'Finding places on Baidu Maps…',
  travelCheckingPlace: 'Checking place details…',
  travelFindingRoutes: 'Calculating routes…',
  travelPlanning: 'Putting your itinerary together…',
  travelTranslating: 'Preparing English directions…',
  travelPlaces: 'Places found',
  travelRoutes: 'Route options',
  travelItinerary: 'Your itinerary',
  travelDay: 'Day {day}',
  travelOpenMap: 'Open in Baidu Maps',
  travelDirections: 'Directions',
  travelWalking: 'Walking',
  travelTransit: 'Public transit',
  travelDriving: 'Driving',
  travelVisit: 'Visit · {duration}',
  travelReturn: 'Return to {place}',
  travelAttribution: 'Places and estimated travel times from Baidu Maps',
  travelSessionExpired: 'Saved map results have expired. Try again to look up the places and routes, or start a new chat',
  travelSessionBusy: 'This trip is already being updated. Wait a moment and try again',
  travelUnavailable: 'Map details are unavailable right now. Please try again shortly',
  travelInvalidResponse: 'The map results could not be displayed. Please try again',
  travelTranslationFailed: 'The map details could not be prepared in English. Please try again',
  scrollToBottom: 'Jump to latest message',
  attachImages: 'Attach images',
  chooseImages: 'Choose images',
  imageFormats: 'JPEG, PNG or WebP · up to 4 images',
  removeImage: 'Remove image: {name}',
  viewImage: 'View image: {name}',
  imagePreview: 'Image preview',
  closeImage: 'Close image',
  preparingImages: 'Preparing images…',
  preparingImage: 'Preparing…',
  imageFailed: 'Could not read',
  imageNeedsRemoval: 'Remove the failed image or choose it again before sending',
  imageTypeError: 'Choose JPEG, PNG or WebP images. No files from this selection were added',
  imageSourceSizeError: 'Choose images smaller than 20 MB each. No files from this selection were added',
  imageDecodeError: 'This image could not be read. Remove it and choose a different file',
  imageSizeError: 'This image is too large to send. Remove it and choose a smaller image',
  imageCountError: 'You can attach up to 4 images per message. No files from this selection were added',
  imageHistoryError: 'This conversation can hold up to 12 images. Start a new chat to send more',
  imageTotalSizeError: 'These images exceed this conversation’s size limit. Remove an image or start a new chat',
  imageRequestError: 'The images could not be sent. Choose fewer or smaller images',
  promptLabels: ['A first trip to China', 'A taste of Shanghai', 'A little everyday Chinese'],
  prompts: [
    'I’m planning my first trip to China. What should I know before I go?',
    'I have a day in Shanghai and love local food. Where should I start?',
    'Teach me a few useful Chinese phrases for ordering food and getting around.',
  ],
};

/** All user-visible interface text is owned by these language dictionaries. */
export const copy: Record<Locale, typeof english> = {
  en: english,
  zh: {
    brand: 'Nihao Agent',
    avatarLabel: 'Nihao 旅行伙伴',
    replyTable: '可横向滚动的表格',
    avatarVoiceIssue: '请查看下方的语音输入提示',
    tagline: '多懂一点当地，旅途就近一点',
    description: '从第一声「你好」到下一段旅程，聊聊中国的生活、美食与旅行',
    heading: '和中国，再近一点',
    placeholder: '这一次，你想了解中国的什么？',
    followUpPlaceholder: '接着聊聊你的问题',
    inputLabel: '发送消息给 Nihao Agent',
    send: '发送消息',
    stop: '停止回复',
    newChat: '新对话',
    language: '界面语言',
    english: 'English',
    chinese: '中文',
    composerHint: '一段旅程，从一个问题开始',
    keyboardHint: 'Shift + Enter 换行',
    startVoiceInput: '开始语音输入',
    voiceInputHint: '语音输入 · 支持中文和英文',
    cancelVoiceInput: '取消语音输入',
    finishVoiceInput: '完成语音输入',
    voicePermission: '请允许使用麦克风…',
    voiceConnecting: '正在连接…',
    voiceListening: '正在聆听',
    voiceFinishing: '正在完成识别…',
    voicePermissionDenied: '请在浏览器的网站设置中允许使用麦克风，然后重试',
    voicePermissionTimeout: '仍在等待麦克风权限，请允许访问后再次点击麦克风',
    voiceNoMicrophone: '未找到麦克风，请连接麦克风后重试',
    voiceMicrophoneBusy: '麦克风未能启动，请检查设备设置后重试',
    voiceUnsupported: '语音输入需要支持麦克风的浏览器，请使用新版 Chrome 或 Safari',
    voiceUnavailable: '语音输入暂时不可用，请稍后重试',
    voiceNetworkError: '语音输入连接失败，请检查网络后重试',
    voiceInterrupted: '语音输入中断了，已识别的文字已保留',
    voiceNoSpeech: '没有识别到语音，请靠近麦克风后重试',
    voiceBusy: '当前语音输入请求较多，请稍等片刻再试',
    voiceTooLong: '语音输入已达到长度限制，请检查文字后继续',
    disclaimer: 'Nihao 的回答可能有误，请核实重要旅行信息',
    user: '你',
    thinking: '正在想一想…',
    writing: 'Nihao 正在回复',
    stopped: '已停止回复',
    copy: '复制回复',
    copied: '已复制',
    copyFailed: '复制失败，请选中文字后复制',
    readAloud: '朗读',
    stopReading: '停止朗读',
    replaySpeech: '重播',
    preparingSpeech: '正在准备语音…',
    cancelPreparingSpeech: '准备中… · 取消',
    readingSpeech: '正在朗读这条回复',
    speechUnavailable: '朗读暂时不可用，请稍后重试',
    speechNetworkError: '语音加载失败，请检查网络后重试',
    speechInterrupted: '朗读中断了，请重试',
    speechTooLong: '这条回复太长，暂时无法朗读，请让 Nihao 简短回答',
    speechUnsupported: '当前浏览器不支持音频播放，请换一个浏览器再试',
    speechPlaybackBlocked: '语音未能开始播放，请再次点击朗读',
    speechBusy: '当前朗读请求较多，请稍等片刻再试',
    retry: '重试',
    error: '回复中断了，请重试',
    networkError: '暂时无法连接，请检查网络后重试',
    limitError: '这段对话有些长了，请开始新对话继续',
    unavailableError: '聊天暂时不可用，请稍后重试',
    rateLimitError: '当前请求较多，请稍等片刻再试',
    emptyError: '没有收到回复，请重试',
    timeoutError: '回复等待超时，请重试',
    replyLimitError: '回复已达到长度限制，请尝试提出更具体的问题',
    invalidRequestError: '这条消息无法发送，请缩短后重试',
    travelFindingPlaces: '正在百度地图查找地点…',
    travelCheckingPlace: '正在查询地点详情…',
    travelFindingRoutes: '正在计算路线…',
    travelPlanning: '正在整理你的行程…',
    travelTranslating: '正在整理中文路线说明…',
    travelPlaces: '找到的地点',
    travelRoutes: '路线方案',
    travelItinerary: '你的行程',
    travelDay: '第 {day} 天',
    travelOpenMap: '在百度地图打开',
    travelDirections: '路线详情',
    travelWalking: '步行',
    travelTransit: '公共交通',
    travelDriving: '驾车',
    travelVisit: '游览 · {duration}',
    travelReturn: '返回{place}',
    travelAttribution: '地点及预计交通耗时来自百度地图',
    travelSessionExpired: '之前查询的地图信息已过期，请重试以重新查询地点和路线，或开始新对话',
    travelSessionBusy: '这份行程正在更新，请稍等片刻后重试',
    travelUnavailable: '地图信息暂时不可用，请稍后重试',
    travelInvalidResponse: '地图结果未能正常显示，请重试',
    travelTranslationFailed: '地图信息未能整理为中文，请重试',
    scrollToBottom: '查看最新消息',
    attachImages: '添加图片',
    chooseImages: '选择图片',
    imageFormats: 'JPEG、PNG 或 WebP，最多 4 张',
    removeImage: '移除图片：{name}',
    viewImage: '查看图片：{name}',
    imagePreview: '图片预览',
    closeImage: '关闭图片',
    preparingImages: '正在处理图片…',
    preparingImage: '处理中…',
    imageFailed: '无法读取',
    imageNeedsRemoval: '请移除失败的图片或重新选择后发送',
    imageTypeError: '请选择 JPEG、PNG 或 WebP 图片，本次选择的文件均未添加',
    imageSourceSizeError: '请选择每张小于 20 MB 的图片，本次选择的文件均未添加',
    imageDecodeError: '无法读取这张图片，请移除后选择其他文件',
    imageSizeError: '这张图片太大，无法发送，请移除后选择更小的图片',
    imageCountError: '每条消息最多添加 4 张图片，本次选择的文件均未添加',
    imageHistoryError: '这段对话最多包含 12 张图片，请开始新对话继续发送',
    imageTotalSizeError: '图片超过这段对话的大小限制，请移除图片或开始新对话',
    imageRequestError: '图片无法发送，请减少图片数量或选择更小的图片',
    promptLabels: ['第一次来中国', '尝尝上海味道', '学几句日常中文'],
    prompts: [
      '我计划第一次来中国旅行，出发之前应该了解些什么？',
      '我在上海有一天时间，想吃当地美食，应该从哪里开始？',
      '教我几句点餐和出行时用得上的中文吧。',
    ],
  },
};

/** Resolve a server error code to localized, actionable interface text. */
export function errorMessage(code: string, locale: Locale): string {
  const text = copy[locale];
  if (code === 'TRAVEL_TRANSLATION_FAILED') return text.travelTranslationFailed;
  if (code === 'TRAVEL_SESSION_EXPIRED') return text.travelSessionExpired;
  if (code === 'TRAVEL_SESSION_BUSY') return text.travelSessionBusy;
  if (code === 'MAPS_NOT_CONFIGURED' || code === 'MAPS_UNAVAILABLE') return text.travelUnavailable;
  if (code === 'INVALID_TRAVEL_RESPONSE') return text.travelInvalidResponse;
  if (code === 'IMAGE_TYPE') return text.imageTypeError;
  if (code === 'IMAGE_SOURCE_TOO_LARGE') return text.imageSourceSizeError;
  if (code === 'INVALID_IMAGE' || code === 'IMAGE_DIMENSIONS') return text.imageDecodeError;
  if (code === 'IMAGE_TOO_LARGE') return text.imageSizeError;
  if (code === 'TOO_MANY_IMAGES') return text.imageCountError;
  if (code === 'IMAGE_HISTORY_LIMIT') return text.imageHistoryError;
  if (code === 'IMAGES_TOO_LARGE') return text.imageTotalSizeError;
  if (code === 'REQUEST_TOO_LARGE') return text.imageRequestError;
  if (code === 'NETWORK_ERROR') return text.networkError;
  if (code === 'EMPTY_RESPONSE') return text.emptyError;
  if (code === 'CONTEXT_LIMIT' || code === 'PAYLOAD_TOO_LARGE' || code === 'TOO_MANY_MESSAGES' || code === 'CONVERSATION_TOO_LONG') return text.limitError;
  if (code === 'RATE_LIMITED' || code === 'RATE_LIMIT' || code === 'BUSY') return text.rateLimitError;
  if (code === 'TIMEOUT') return text.timeoutError;
  if (code === 'REPLY_LIMIT') return text.replyLimitError;
  if (code === 'INVALID_REQUEST') return text.invalidRequestError;
  if (code === 'NOT_CONFIGURED' || code === 'PROVIDER_UNAVAILABLE' || code === 'AUTH_ERROR') return text.unavailableError;
  return text.error;
}

/** Never render raw speech provider messages or credentials. */
export function speechErrorMessage(code: string, locale: Locale): string {
  const text = copy[locale];
  if (code === 'SPEECH_NETWORK_ERROR' || code === 'NETWORK_ERROR') return text.speechNetworkError;
  if (code === 'SPEECH_TOO_LONG' || code === 'SPEECH_TEXT_TOO_LONG' || code === 'REQUEST_TOO_LARGE') return text.speechTooLong;
  if (code === 'SPEECH_UNSUPPORTED') return text.speechUnsupported;
  if (code === 'SPEECH_PLAYBACK_BLOCKED') return text.speechPlaybackBlocked;
  if (code === 'SPEECH_BUSY' || code === 'BUSY' || code === 'RATE_LIMITED' || code === 'SPEECH_RATE_LIMITED') return text.speechBusy;
  if (code === 'SPEECH_INTERRUPTED' || code === 'SPEECH_TIMEOUT' || code === 'SPEECH_INVALID_RESPONSE' || code === 'SPEECH_EMPTY') return text.speechInterrupted;
  return text.speechUnavailable;
}

/** Dictation exposes stable public codes, never raw provider messages. */
export function dictationErrorMessage(code: string, locale: Locale): string {
  const text = copy[locale];
  if (code === 'ASR_PERMISSION_DENIED') return text.voicePermissionDenied;
  if (code === 'ASR_PERMISSION_TIMEOUT') return text.voicePermissionTimeout;
  if (code === 'ASR_NO_MICROPHONE') return text.voiceNoMicrophone;
  if (code === 'ASR_MICROPHONE_BUSY') return text.voiceMicrophoneBusy;
  if (code === 'ASR_UNSUPPORTED') return text.voiceUnsupported;
  if (code === 'ASR_NETWORK_ERROR') return text.voiceNetworkError;
  if (code === 'ASR_NO_SPEECH') return text.voiceNoSpeech;
  if (code === 'ASR_BUSY') return text.voiceBusy;
  if (code === 'ASR_TOO_LONG' || code === 'ASR_TEXT_TOO_LONG') return text.voiceTooLong;
  if (['ASR_INTERRUPTED', 'ASR_TIMEOUT', 'ASR_INVALID_AUDIO', 'ASR_INVALID_RESPONSE', 'ASR_CONNECTION_SLOW', 'ASR_MICROPHONE_LOST'].includes(code)) return text.voiceInterrupted;
  return text.voiceUnavailable;
}
