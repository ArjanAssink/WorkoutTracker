import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/ingest/csv.js";
import { parseArchiveActivities, parseArchiveDate, parseMediaCaptions, parsePrivacyZone } from "../src/ingest/stravaArchive.js";

describe("csv", () => {
  it("handles quotes, doubled quotes, embedded newlines and repeated headers", () => {
    const rows = parseCsv('A,B,A\n1,"x, ""y""\nz",3\n,,\n4,5,6\n');
    expect(rows).toEqual([{ A: "1", B: 'x, "y"\nz', "A 2": "3" }, { A: "4", B: "5", "A 2": "6" }]);
  });
});

describe("the Strava archive", () => {
  it("reads the American date as UTC", () => {
    expect(parseArchiveDate("Sep 27, 2026, 7:03:56 AM")).toBe("2026-09-27T07:03:56.000Z");
    expect(parseArchiveDate("Aug 23, 2023, 12:05:00 PM")).toBe("2023-08-23T12:05:00.000Z");
    expect(parseArchiveDate("Aug 23, 2023, 12:05:00 AM")).toBe("2023-08-23T00:05:00.000Z");
    expect(parseArchiveDate("nonsense")).toBeUndefined();
  });

  const header = "Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,Average Speed,Elevation Gain,Elevation Loss,Elevation Low,Elevation High,Max Grade,Average Grade,Average Positive Grade,Average Negative Grade,Max Cadence,Average Cadence,Max Heart Rate,Average Heart Rate,Max Watts,Average Watts,Calories,Max Temperature,Average Temperature,Relative Effort,Total Work,Number of Runs,Uphill Time,Downhill Time,Other Time,Perceived Exertion,Type,Start Time,Weighted Average Power,Power Count,Prefer Perceived Exertion,Perceived Relative Effort,Commute,Total Weight Lifted,From Upload,Grade Adjusted Distance,Weather Observation Time,Weather Condition,Weather Temperature,Media";
  const run = '20346204813,"Sep 27, 2026, 7:03:56 AM",Morning Run,Run,"Easy one",1492,3.57,184.0,34,false,,,activities/21500847014.fit.gz,,,1492.0,1385.0,3573.3,4.72,2.58,4.2,2.6,1.2,5.4,13.7,-0.1,,,,,184.0,158.0,,230.0,257.0,,,34.0,,,,,,,,,235.0,1493.0,,,0.0,,1.0,3592.0,,clear,14.5,"||media/A.jpg|media/B.mp4"';
  const lift = '1,"Sep 6, 2026, 7:30:21 AM",Gym,Weight Training,"",1337,,,,false,,Specialized Diverge,activities/x.gpx,,9.0,1337.0,1158.0,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,""';
  const reactions = 'Reaction Date,Reaction Type,Parent Type,Parent ID\n"Aug 23, 2023, 7:56:02 PM",Kudos,Activity,20346204813\n"Aug 23, 2023, 7:57:02 PM",Kudos,Activity,20346204813\n"Aug 23, 2023, 7:58:02 PM",Kudos,Activity,999\n';

  it("turns rows into activities with the precise columns, kudos counted and media split", () => {
    const [a, b] = parseArchiveActivities(`${header}\n${run}\n${lift}\n`, reactions);
    expect(a!.activity).toMatchObject({ id: 1, sport_type: "WeightTraining", start_date: "2026-09-06T07:30:21.000Z", elapsed_time: 1337, moving_time: 1158, gear_id: "Specialized Diverge" });
    expect(a!.filename).toBe("activities/x.gpx");
    expect(b!.activity).toMatchObject({ id: 20346204813, name: "Morning Run", sport_type: "Run", distance: 3573.3, elapsed_time: 1492, moving_time: 1385, max_heartrate: 184, average_heartrate: 158, suffer_score: 34, kudos_count: 2, total_photo_count: 2, description: "Easy one", weather_condition: "clear", temperature_c: 14.5 });
    expect(b!.media).toEqual(["media/A.jpg", "media/B.mp4"]);
    expect("gear" in a! && a!.gear).toBe("Specialized Diverge");
    expect(Object.values(b!.activity).every((v) => v !== undefined)).toBe(true);
  });

  it("reads captions and the privacy zone", () => {
    expect(parseMediaCaptions('Media Filename,Media Caption\nmedia/A.jpg,"Dunes"\nmedia/B.jpg,""\n').get("media/A.jpg")).toBe("Dunes");
    expect(parsePrivacyZone('Address,Radius,Latitude & Longitude\n"Somewhere 1, Town",0.80 kilometers,"52.17, 4.44"\n')).toEqual({ lat: 52.17, lon: 4.44, radiusMeters: 800 });
    expect(parsePrivacyZone("Address,Radius,Latitude & Longitude\n")).toBeUndefined();
  });
});
