import {env} from 'cloudflare:workers';
export function db(){if(!env.DB)throw new Error('Storage unavailable. Please try again shortly.');return env.DB;}
export function stmt(sql:string,...params:unknown[]){return db().prepare(sql).bind(...params);}
export async function all(sql:string,...params:unknown[]){return (await stmt(sql,...params).all()).results as Record<string,any>[];}
export async function one(sql:string,...params:unknown[]){return await stmt(sql,...params).first() as Record<string,any>|null;}
