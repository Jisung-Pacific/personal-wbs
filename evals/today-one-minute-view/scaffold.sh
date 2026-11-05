#!/usr/bin/env bash
# Seeds ./ledger with a small synthetic ledger (a subset of sample/en) for this eval case.
set -euo pipefail
mkdir -p ledger
printf '\xef\xbb\xbf' > ledger/wbs.csv
cat >> ledger/wbs.csv <<'CSV'
year,code,level,area,package,parent,task,start,end,date_text,start_month,status,key_result,source,due,importance,size,depends_on,blocker,last_progress,goal,evidence
2026,1.1.8,3,1 Research,1.1 Thesis writing,,Thesis defence passed with minor revisions,2026-10-14,2026-10-14,2026-10-14,2026-10,done,Y,Claude,2026-10-14,high,S,,,2026-10-14,Finish the MSc,claude:ca04c79f;cal:2026-10-14
2026,1.1.9,3,1 Research,1.1 Thesis writing,,"Final thesis with the defence revisions, 7 of 12 done",2026-10-19,,2026-10-19 ~,2026-10,in_progress,,Claude,2026-11-27,high,M,1.1.8,,2026-11-04,Finish the MSc,claude:a2c68e45
2026,1.1.10,3,1 Research,1.1 Thesis writing,,Thesis repository submission,,,planned,,waiting,,Claude,2026-11-30,high,S,1.1.9,prerequisite: final thesis (1.1.9),,Finish the MSc,claude:551fd8f9
2026,1.2.1,3,1 Research,1.2 Conference paper,,Main-track conference paper: anomaly detection under sensor drift,2026-02-02,,2026-02-02 ~,2026-02,waiting,,Claude,,,XL,,external review: program committee,2026-08-08,Publish the research,claude:2b855c1f
2026,1.2.1.1,4,1 Research,1.2 Conference paper,1.2.1 Main-track conference paper: anomaly detection under sensor drift,Experiments frozen: 5 datasets and 6 baselines,2026-02-02,2026-02-04,2026-02-02 ~ 02-04,2026-02,done,,Claude,,,M,,,2026-02-04,Publish the research,claude:cd02c5e1
2026,1.2.1.2,4,1 Research,1.2 Conference paper,1.2.1 Main-track conference paper: anomaly detection under sensor drift,"Draft v1, 9 pages",2026-03-09,2026-03-30,2026-03-09 ~ 03-30,2026-03,done,,Claude,,,L,,,2026-03-30,Publish the research,claude:7691b06f
2026,1.2.1.3,4,1 Research,1.2 Conference paper,1.2.1 Main-track conference paper: anomaly detection under sensor drift,Submitted to the main track,2026-05-13,2026-05-13,2026-05-13,2026-05,done,,Claude,2026-05-15,high,S,,,2026-05-13,Publish the research,claude:66c1494e
2026,1.2.1.4,4,1 Research,1.2 Conference paper,1.2.1 Main-track conference paper: anomaly detection under sensor drift,"Rebuttal submitted: 4 reviewers, 11 points answered",2026-08-03,2026-08-05,2026-08-03 ~ 08-05,2026-08,done,,Claude,2026-08-07,,M,,,2026-08-05,Publish the research,claude:b98c67c2
2026,1.2.1.5,4,1 Research,1.2 Conference paper,1.2.1 Main-track conference paper: anomaly detection under sensor drift,Final decision from the program committee,2026-08-08,,2026-08-08 ~,2026-08,waiting,,Claude,,,S,,external review: program committee,2026-08-08,Publish the research,claude:28aaca51
2026,1.3.1,3,1 Research,1.3 Journal extension,,"Extension plan: 3 new experiments, about 40% new material",2026-09-07,2026-09-08,2026-09-07 ~ 09-08,2026-09,done,,Claude,,,S,2025:1.2.1;1.2.1,,2026-09-08,Publish the research,claude:e7a46309
2026,1.3.2,3,1 Research,1.3 Journal extension,,Streaming-setting experiments,2026-09-21,,2026-09-21 ~,2026-09,in_progress,,Claude,2026-12-18,,L,1.3.1,,2026-11-03,Publish the research,claude:9c9011ef
2026,1.3.2.1,4,1 Research,1.3 Journal extension,1.3.2 Streaming-setting experiments,Streaming experiments on dataset A,2026-09-21,2026-10-02,2026-09-21 ~ 10-02,2026-09,done,,Claude,,,L,,,2026-10-02,Publish the research,gh:example/anomaly-bench@77216e9
2026,1.3.2.2,4,1 Research,1.3 Journal extension,1.3.2 Streaming-setting experiments,Streaming experiments on dataset B,2026-10-05,2026-10-16,2026-10-05 ~ 10-16,2026-10,done,,Claude,,,L,,,2026-10-16,Publish the research,gh:example/anomaly-bench@ce76e9f
2026,1.3.2.3,4,1 Research,1.3 Journal extension,1.3.2 Streaming-setting experiments,Streaming experiments on dataset C,2026-10-26,,2026-10-26 ~,2026-10,in_progress,,Claude,2026-12-18,,L,,,2026-11-03,Publish the research,claude:a7e6529b;gh:example/anomaly-bench@256badf
2026,1.3.3,3,1 Research,1.3 Journal extension,,Related-work update: 19 new papers,2026-10-12,,2026-10-12 ~,2026-10,in_progress,,Claude,,,M,,,2026-10-22,Publish the research,claude:d39630d6
2026,1.3.4,3,1 Research,1.3 Journal extension,,Survey paper on lightweight anomaly detection,2026-09-28,,2026-09-28 ~,2026-09,backlog,,Claude,,,M,,on hold: after the PhD applications,2026-10-05,Publish the research,claude:988af3fb
2026,1.4.6,3,1 Research,1.4 Lab seminar,,"Lab seminar talk: review of streaming anomaly detection, slides in progress",2026-11-02,,2026-11-02 ~,2026-11,in_progress,,Claude,2026-11-12,,S,,,2026-11-05,Finish the MSc,claude:f88c422b
2026,2.1.1,3,2 Graduate School,2.1 PhD applications,,"Target list updated: 6 programs, deadlines from Dec 1 to Jan 15",2026-09-01,2026-09-01,2026-09-01,2026-09,done,,Claude,,,S,2025:2.1.4,,2026-09-01,PhD admission for 2027,claude:072a98d2
2026,2.1.2,3,2 Graduate School,2.1 PhD applications,,"Statement of purpose v3, 1,000 words",2026-09-14,2026-09-18,2026-09-14 ~ 09-18,2026-09,done,,Claude,,,M,,,2026-09-18,PhD admission for 2027,claude:3678bc8d;drive:Statement of purpose v3
2026,2.1.3,3,2 Graduate School,2.1 PhD applications,,Recommendation requests sent to 3 recommenders through the application portals,2026-10-05,,2026-10-05 ~,2026-10,waiting,,Claude,2026-11-25,high,S,,external reply: 1 of 3 recommenders (internship supervisor),2026-10-20,PhD admission for 2027,claude:4affdcd1
2026,2.1.4,3,2 Graduate School,2.1 PhD applications,,Applications to 4 programs,2026-10-07,,2026-10-07 ~,2026-10,in_progress,,Claude,,high,XL,,,2026-11-05,PhD admission for 2027,claude:53740902
2026,2.1.4.1,4,2 Graduate School,2.1 PhD applications,2.1.4 Applications to 4 programs,University A application submitted,2026-10-19,2026-10-28,2026-10-19 ~ 10-28,2026-10,done,,Claude,2026-11-01,,M,2.1.2,,2026-10-28,PhD admission for 2027,claude:804c25d6;drive:University A application
2026,2.1.4.2,4,2 Graduate School,2.1 PhD applications,2.1.4 Applications to 4 programs,University B application: forms and tailored statement,2026-10-26,,2026-10-26 ~,2026-10,in_progress,,Claude,2026-12-01,,M,,,2026-11-05,PhD admission for 2027,claude:3d93fd4c
2026,2.1.4.3,4,2 Graduate School,2.1 PhD applications,2.1.4 Applications to 4 programs,University C application,2026-11-02,,2026-11-02 ~,2026-11,waiting,,Claude,2026-12-15,,M,2.1.3,prerequisite: recommendation letters (2.1.3),2026-11-02,PhD admission for 2027,claude:c38084a0
2026,2.1.4.4,4,2 Graduate School,2.1 PhD applications,2.1.4 Applications to 4 programs,University D application,2026-10-07,,2026-10-07 ~,2026-10,backlog,,Claude,,,S,,on hold: deadline clashes with the thesis defence,2026-10-12,PhD admission for 2027,claude:9620bf0d
2026,2.1.5,3,2 Graduate School,2.1 PhD applications,,Interview preparation: 20 question cards and a 5-minute research pitch,2026-11-02,,2026-11-02 ~,2026-11,in_progress,,Claude,,,M,,,2026-11-04,PhD admission for 2027,claude:4265bb31
2026,2.2.2,3,2 Graduate School,2.2 Scholarships,,External PhD scholarship application submitted,2026-09-21,2026-09-25,2026-09-21 ~ 09-25,2026-09,done,,Claude,2026-09-30,,M,,,2026-09-25,PhD admission for 2027,claude:0f977044
2026,2.2.3,3,2 Graduate School,2.2 Scholarships,,Scholarship decision,2026-09-30,,2026-09-30 ~,2026-09,waiting,,Claude,,,S,2.2.2,external review: scholarship committee,2026-09-30,PhD admission for 2027,claude:e8f6e0bd
2026,3.1.7,3,3 Startup,3.1 Sproutlog releases,,Dark mode,2026-06-15,,2026-06-15 ~,2026-06,backlog,,Claude,,,S,,on hold: after v1.3,2026-06-20,Grow Sproutlog,claude:86048719
2026,3.1.11,3,3 Startup,3.1 Sproutlog releases,,v1.3 offline mode,2026-09-14,,2026-09-14 ~,2026-09,in_progress,,Claude,2026-11-20,high,L,,,2026-11-01,Grow Sproutlog,claude:9bca3cb7
2026,3.1.11.1,4,3 Startup,3.1 Sproutlog releases,3.1.11 v1.3 offline mode,Offline storage layer and sync conflict rules,2026-09-14,2026-10-02,2026-09-14 ~ 10-02,2026-09,done,,Claude,,,L,,,2026-10-02,Grow Sproutlog,gh:example/sproutlog#88
2026,3.1.11.2,4,3 Startup,3.1 Sproutlog releases,3.1.11 v1.3 offline mode,Offline UI states and error messages,2026-10-12,,2026-10-12 ~,2026-10,in_progress,,Claude,2026-11-13,,M,,,2026-11-01,Grow Sproutlog,claude:c6c91b92
2026,3.1.11.3,4,3 Startup,3.1 Sproutlog releases,3.1.11 v1.3 offline mode,Beta build for 20 testers,,,planned,,waiting,,Claude,,,S,3.1.11.2,prerequisite: offline UI (3.1.11.2),,Grow Sproutlog,claude:2ee0289d
2026,3.2.15,3,3 Startup,3.2 Growth and operations,,Premium tier pricing experiment design,2026-10-07,,2026-10-07 ~,2026-10,in_progress,,Claude·GPT,,,M,,,2026-10-09,Grow Sproutlog,claude:c6c80e2b;gpt:1b29fc99
2026,3.3.4,3,3 Startup,3.3 Grants and funding,,"Grant final report, draft at 60%",2026-10-12,,2026-10-12 ~,2026-10,in_progress,,Claude,2026-12-10,,M,,,2026-10-15,Grow Sproutlog,claude:46e40990
2026,3.3.5,3,3 Startup,3.3 Grants and funding,,Angel investor conversations,2026-06-08,,2026-06-08 ~,2026-06,backlog,,GPT,,,S,,on hold: until the PhD decisions,2026-07-01,Grow Sproutlog,claude:0acd8be1;gpt:c5b2e75a
2026,4.1.10,3,4 Career,4.1 Teaching assistant,,"Machine Learning: assignment 3 grading, 31 of 58 graded",2026-11-03,,2026-11-03 ~,2026-11,in_progress,,Claude,2026-11-10,,M,,,2026-11-05,,claude:f92e2339
2026,4.2.1,3,4 Career,4.2 Talks and networking,,"Invited talk at the undergraduate AI club, 40 attendees",2026-04-22,2026-04-22,2026-04-22,2026-04,done,,Claude,,,S,,,2026-04-22,,claude:816bee06;cal:2026-04-22
2026,5.3.6,3,5 Admin,5.3 Tax and bookkeeping,,"Q3 bookkeeping: receipts collected, ledger not reconciled yet",2026-10-07,,2026-10-07 ~,2026-10,in_progress,,Claude,2026-10-31,,S,,,2026-10-12,Admin on time,claude:50e40d54
2025,1.2.1,3,1 Research,1.2 Workshop paper,,Workshop paper: lightweight anomaly detection for battery sensors,2025-07-14,2025-12-08,2025-07-14 ~ 12-08,2025-07,done,Y,Claude,,,L,,,2025-12-08,Publish the research,claude:30cbc97d
2025,1.2.1.1,4,1 Research,1.2 Workshop paper,1.2.1 Workshop paper: lightweight anomaly detection for battery sensors,"First full draft, 6 pages",2025-07-14,2025-07-20,2025-07-14 ~ 07-20,2025-07,done,,Claude,,,M,,,2025-07-20,Publish the research,claude:6472f1a3;drive:Workshop paper draft v1
2025,1.2.1.2,4,1 Research,1.2 Workshop paper,1.2.1 Workshop paper: lightweight anomaly detection for battery sensors,Lab internal review: 14 comments resolved,2025-08-11,2025-08-11,2025-08-11,2025-08,done,,Claude,,,S,,,2025-08-11,Publish the research,claude:66237a04
2025,1.2.1.3,4,1 Research,1.2 Workshop paper,1.2.1 Workshop paper: lightweight anomaly detection for battery sensors,Submitted to the ML-for-systems workshop,2025-08-28,2025-08-28,2025-08-28,2025-08,done,,Claude,2025-08-29,high,S,,,2025-08-28,Publish the research,claude:64e50cad
2025,1.2.1.4,4,1 Research,1.2 Workshop paper,1.2.1 Workshop paper: lightweight anomaly detection for battery sensors,Acceptance notification: 3 of 3 reviewers positive,2025-10-01,2025-10-01,2025-10-01,2025-10,done,,Claude,,,S,,,2025-10-01,Publish the research,gmail:7b451a81682c
2025,1.2.1.5,4,1 Research,1.2 Workshop paper,1.2.1 Workshop paper: lightweight anomaly detection for battery sensors,Camera-ready version submitted,2025-10-09,2025-10-10,2025-10-09 ~ 10-10,2025-10,done,,Claude,2025-10-15,,S,,,2025-10-10,Publish the research,claude:66836886
2025,1.2.1.6,4,1 Research,1.2 Workshop paper,1.2.1 Workshop paper: lightweight anomaly detection for battery sensors,"Poster presented at the workshop, 30+ visitors",2025-12-08,2025-12-08,2025-12-08,2025-12,done,,Claude,,,S,,,2025-12-08,Publish the research,claude:0fef7928;cal:2025-12-08
2025,2.1.4,3,2 Graduate School,2.1 Application preparation,,"Program shortlist: 9 programs compared on 6 criteria, 5 chosen",2025-08-18,2025-08-23,2025-08-18 ~ 08-23,2025-08,done,,Claude,,,M,,,2025-08-23,PhD admission for 2027,claude:7bdc968b
CSV
printf '\xef\xbb\xbf' > ledger/plan.csv
cat >> ledger/plan.csv <<'CSV'
kind,year,target,note,decided,recheck
goal,,Finish the MSc,Thesis defended and submitted by the end of 2026,2026-09-14,
goal,,PhD admission for 2027,An offer from at least one target program,2026-09-14,
goal,,Publish the research,"One workshop paper, one main-track paper, a journal extension submitted",2026-09-14,
goal,,Grow Sproutlog,"1,000 weekly active users with a sustainable routine",2026-09-14,
goal,,Admin on time,"No missed enrollment, tax or paperwork deadlines",2026-09-14,
focus,2026,1.1,Final thesis and repository submission by the end of November,2026-11-02,2026-11-30
focus,2026,2.1,"PhD applications: University B by Dec 1, University C by Dec 15",2026-11-02,2026-11-30
checkup,2026,,"Weekly health check, first one after the bootstrap",2026-11-02,2026-11-09
config,,publish,folder:.,2026-09-14,
CSV
