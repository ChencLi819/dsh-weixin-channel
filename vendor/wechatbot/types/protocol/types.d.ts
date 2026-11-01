export declare const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export declare const CHANNEL_VERSION: string;
export declare enum MessageType {
    USER = 1,
    BOT = 2
}
export declare enum MessageState {
    NEW = 0,
    GENERATING = 1,
    FINISH = 2
}
export declare enum MessageItemType {
    TEXT = 1,
    IMAGE = 2,
    VOICE = 3,
    FILE = 4,
    VIDEO = 5
}
export declare enum MediaType {
    IMAGE = 1,
    VIDEO = 2,
    FILE = 3,
    VOICE = 4
}
export interface BaseInfo {
    channel_version: string;
    /** UA-style identifier of the app driving this bot (e.g. "MyApp/1.2 (prod)"). */
    bot_agent?: string;
}
export interface CDNMedia {
    encrypt_query_param: string;
    aes_key: string;
    encrypt_type?: 0 | 1;
    /** Complete download URL returned by server; when set, use directly instead of building from encrypt_query_param. */
    full_url?: string;
}
export interface TextItem {
    text: string;
}
export interface ImageItem {
    media?: CDNMedia;
    thumb_media?: CDNMedia;
    aeskey?: string;
    url?: string;
    mid_size?: number | string;
    thumb_size?: number | string;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number | string;
}
export interface VoiceItem {
    media?: CDNMedia;
    encode_type?: number;
    bits_per_sample?: number;
    sample_rate?: number;
    text?: string;
    playtime?: number;
}
export interface FileItem {
    media?: CDNMedia;
    file_name?: string;
    md5?: string;
    len?: string;
}
export interface VideoItem {
    media?: CDNMedia;
    video_size?: number | string;
    play_length?: number;
    video_md5?: string;
    thumb_media?: CDNMedia;
    thumb_size?: number | string;
    thumb_height?: number;
    thumb_width?: number;
}
export interface RefMessage {
    title?: string;
    message_item?: WireMessageItem;
}
export interface WireMessageItem {
    type: MessageItemType;
    text_item?: TextItem;
    image_item?: ImageItem;
    voice_item?: VoiceItem;
    file_item?: FileItem;
    video_item?: VideoItem;
    ref_msg?: RefMessage;
}
export interface WireMessage {
    seq?: number;
    message_id?: number;
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    create_time_ms: number;
    update_time_ms?: number;
    delete_time_ms?: number;
    session_id?: string;
    group_id?: string;
    message_type: MessageType;
    message_state: MessageState;
    context_token: string;
    item_list: WireMessageItem[];
}
export interface GetUpdatesRequest {
    get_updates_buf: string;
    base_info: BaseInfo;
}
export interface GetUpdatesResponse {
    ret: number;
    msgs: WireMessage[];
    get_updates_buf: string;
    longpolling_timeout_ms?: number;
    errcode?: number;
    errmsg?: string;
}
export interface SendMessageRequest {
    msg: {
        from_user_id: string;
        to_user_id: string;
        client_id: string;
        message_type: MessageType;
        message_state: MessageState;
        context_token: string;
        item_list: WireMessageItem[];
    };
    base_info: BaseInfo;
}
export interface SendTypingRequest {
    ilink_user_id: string;
    typing_ticket: string;
    status: 1 | 2;
    base_info: BaseInfo;
}
export interface GetConfigResponse {
    typing_ticket?: string;
    ret?: number;
    errcode?: number;
    errmsg?: string;
}
export interface QrCodeResponse {
    qrcode: string;
    qrcode_img_content: string;
}
export interface QrStatusResponse {
    status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'binded_redirect' | 'need_verifycode' | 'verify_code_blocked';
    bot_token?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
    baseurl?: string;
    /** New host to redirect polling to when status is 'scaned_but_redirect'. */
    redirect_host?: string;
}
export interface GetUploadUrlRequest {
    filekey: string;
    media_type: MediaType;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    thumb_rawsize?: number;
    thumb_rawfilemd5?: string;
    thumb_filesize?: number;
    no_need_thumb?: boolean;
    aeskey?: string;
    base_info: BaseInfo;
}
export interface GetUploadUrlResponse {
    upload_param: string;
    thumb_upload_param?: string;
    /** Complete upload URL returned by server; when set, use directly instead of building from upload_param. */
    upload_full_url?: string;
}
//# sourceMappingURL=types.d.ts.map