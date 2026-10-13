import { attach,type AttachConnection,type AttachOptions,type AttachReason } from './attach.js';
import { validateSettings } from '../shared/validate.js';
import { Logger } from '../daemon/log.js';
import { getPaths } from '../shared/paths.js';
export async function configuredAttach(connection:AttachConnection,id:string,options:AttachOptions={}):Promise<AttachReason>{
 const settings=validateSettings((await connection.request({kind:'settings.get'})).settings);
 return attach(connection,id,{...options,settings,bar:settings.bar??'off',fallbackLog:options.fallbackLog??(text=>new Logger(getPaths().log).error(text))});
}
