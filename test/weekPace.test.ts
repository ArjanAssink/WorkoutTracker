import { describe, expect, it } from "vitest";
import { weekOutlook, weekPace } from "../src/domain/weekPace.js";
import type { Workout } from "../src/domain/workout.js";
import type { WeekReview } from "../src/domain/goals.js";
const DAY=86400000;
const now=new Date("2026-11-20T11:00:00Z"); // Friday noon, Amsterdam
const current={weekStart:"2026-11-16",effort:150} as WeekReview;
function workout(at:string,effort:number,end=at):Workout { return {id:at,activityType:"strength",startedAt:at,endedAt:end,durationSeconds:3600,effort,effortModel:"trimp",source:"manual",recordedAt:at}; }
function history(count=4):Workout[] {
  const monday=Date.parse("2026-11-16T00:00:00Z");
  return Array.from({length:count},(_,i)=>[1,4,6].map(day=>workout(new Date(monday-(i+1)*7*DAY+day*DAY+17*3600000).toISOString(),100))).flat();
}
describe("weekday pace and weekly projection",()=>{
  it("uses same-weekday history and adds typical remaining effort to actual progress",()=>{
    expect(weekPace(history(),current,now)).toMatchObject({historyWeeks:4,typicalSoFar:100,typicalRemaining:200,typicalTotal:300,projectedEffort:350,projectionPaused:false});
  });
  it("compares the actual local time, not the end of the day",()=>{
    expect(weekPace(history(),current,new Date("2026-11-20T20:00:00Z"))).toMatchObject({typicalSoFar:200,typicalRemaining:100,projectedEffort:250});
  });
  it("does not invent a trend from fewer than four weeks or zero typical effort",()=>{
    expect(weekPace(history(3),current,now)).toBeUndefined();
    expect(weekPace(history().map(w=>({...w,effort:0})),current,now)).toBeUndefined();
  });
  it("ignores future sessions and the current week when learning the usual pattern",()=>{
    expect(weekPace([...history(),workout("2026-11-17T17:00:00Z",999),workout("2026-11-24T17:00:00Z",999)],current,now)?.typicalTotal).toBe(300);
  });
  it("does not project historical or future weeks",()=>{
    expect(weekPace(history(),{...current,weekStart:"2026-11-09"},now)).toBeUndefined();
    expect(weekPace(history(),{...current,weekStart:"2026-11-23"},now)).toBeUndefined();
  });
  it("pauses projections on a tagged rest week while retaining neutral context",()=>{
    const p=weekPace(history(),current,now,{label:"Rest week",note:""});
    expect(p?.projectionPaused).toBe(true);expect(p?.projectedEffort).toBeUndefined();expect(p?.typicalSoFar).toBe(100);
  });
  it("uses completed sessions for the same-time benchmark",()=>{
    const h=history().map(w=>w.startedAt.includes('T17:')?{...w,endedAt:new Date(Date.parse(w.startedAt)+2*3600000).toISOString()}:w);
    expect(weekPace(h,current,new Date("2026-11-20T18:00:00Z"))?.typicalSoFar).toBe(100);
  });
  it("keeps local-time comparisons consistent across the autumn clock change",()=>{
    const h=["2026-10-23T11:00:00+02:00","2026-10-30T11:00:00+01:00","2026-11-06T11:00:00+01:00","2026-11-13T11:00:00+01:00"].map(t=>workout(t,100));
    expect(weekPace(h,current,new Date("2026-11-20T10:30:00Z"))?.typicalSoFar).toBe(100);
    expect(weekPace(h,current,new Date("2026-11-20T09:30:00Z"))?.typicalSoFar).toBe(0);
  });
  it("is stable early Monday without dividing by a tiny progress fraction",()=>{
    expect(weekPace(history(),{...current,effort:0},new Date("2026-11-16T07:00:00Z"))).toMatchObject({typicalSoFar:0,projectedEffort:300});
  });
});

describe("the current week's outlook",()=>{
  const week=(totalSessions:number,verdict:WeekReview["verdict"]="short")=>({...current,totalSessions,verdict,goodWeekSessions:5,veryGoodWeekSessions:6} as WeekReview);
  // history(): three sessions a week on Tue/Fri/Sun evenings; by Friday noon one is done, two to come.
  it("counts the sessions the usual week still has to come, leaving out excluded activities",()=>{
    expect(weekPace(history(),current,now)).toMatchObject({typicalSessionsSoFar:1,typicalSessionsRemaining:2});
    expect(weekPace(history(),current,now,undefined,["strength"])).toMatchObject({typicalSessionsSoFar:0,typicalSessionsRemaining:0});
  });
  it("is on track, high or low by where the projection lands on the ladder",()=>{
    const pace=weekPace(history(),current,now);
    expect(weekOutlook(week(3),pace)).toEqual({status:"ontrack",projectedSessions:5});
    expect(weekOutlook(week(4),pace)).toEqual({status:"high",projectedSessions:6});
    expect(weekOutlook(week(2),pace)).toEqual({status:"low",projectedSessions:4});
  });
  it("never reads below what is already earned, and a perfect week is settled",()=>{
    const pace={...weekPace(history(),current,now)!,typicalSessionsRemaining:0};
    expect(weekOutlook(week(5,"good"),pace)?.status).toBe("ontrack");
    expect(weekOutlook(week(6,"verygood"),pace)?.status).toBe("high");
    expect(weekOutlook(week(4,"perfect"),pace)).toEqual({status:"perfect"});
  });
  it("pauses on a rest week and stays silent without a baseline",()=>{
    expect(weekOutlook(week(1),weekPace(history(),current,now,{label:"Rest week",note:""}))).toEqual({status:"paused"});
    expect(weekOutlook(week(1),undefined)).toBeUndefined();
  });
});
