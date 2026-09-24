export const STATUSES=['scheduled','enroute','arrived','started','ended','cancelled'] as const;
export function pakistanToday(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function routeMatches(origin:string,destination:string,stops:string,from:string,to:string){
 const path=[origin,...stops.split('|').filter(Boolean),destination].map(s=>s.trim().toLocaleLowerCase());
 const a=from.trim().toLocaleLowerCase(),b=to.trim().toLocaleLowerCase();
 if(!a&&!b)return true;
 if(!a)return path.some(p=>p.includes(b));if(!b)return path.some(p=>p.includes(a));
 return path.some((p,i)=>p.includes(a)&&path.slice(i+1).some(q=>q.includes(b)));
}
export function departureDates(start:string,days:number[]){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||Number.isNaN(Date.parse(start+'T00:00:00Z'))||new Date(start+'T00:00:00Z').toISOString().slice(0,10)!==start)throw new Error('Choose a valid date.');
 if(!days.length)return [start];
 const dates:string[]=[];for(let i=0;i<28;i++){const d=new Date(start+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+i);if(days.includes(d.getUTCDay()))dates.push(d.toISOString().slice(0,10));}return dates;
}
export function canTransition(from:string,to:string){return ({scheduled:['enroute','cancelled'],enroute:['arrived','cancelled'],arrived:['started','cancelled'],started:['ended']} as Record<string,string[]>)[from]?.includes(to)??false;}
