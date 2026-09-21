// Discovery filter options for MainPage.
// Values mirror the backend taxonomy in server/utils/discovery.js
// (canonical UPPER_SNAKE for career/exam type; 1-12 for month;
// OPEN_NOW / UPCOMING / CLOSED for application status). Labels only.

export const CAREER_TYPE_OPTIONS = [
    { value: "ENGINEERING", label: "Engineering" },
    { value: "MEDICAL", label: "Medical" },
    { value: "MANAGEMENT", label: "Management (MBA/BBA)" },
    { value: "LAW", label: "Law" },
    { value: "GOVERNMENT_JOBS", label: "Government Jobs (UPSC/State PSC)" },
    { value: "BANKING_INSURANCE", label: "Banking & Insurance" },
    { value: "DEFENCE", label: "Defence" },
    { value: "TEACHING_EDUCATION", label: "Teaching & Education" },
    { value: "DESIGN_ARCHITECTURE", label: "Design & Architecture" },
    { value: "SCIENCE_RESEARCH", label: "Science & Research" },
    { value: "ARTS_HUMANITIES", label: "Arts & Humanities" },
    { value: "COMMERCE_FINANCE", label: "Commerce & Finance" },
    { value: "IT_COMPUTER_APPLICATIONS", label: "IT & Computer Applications" },
    { value: "AGRICULTURE", label: "Agriculture" },
    { value: "PARAMEDICAL_NURSING", label: "Paramedical & Nursing" },
    { value: "HOTEL_MANAGEMENT_HOSPITALITY", label: "Hotel Management & Hospitality" },
    { value: "MASS_COMMUNICATION_JOURNALISM", label: "Mass Communication & Journalism" },
    { value: "RAILWAYS", label: "Railways" },
    { value: "SSC", label: "SSC (Staff Selection)" },
];

export const EXAM_TYPE_OPTIONS = [
    { value: "ENTRANCE_EXAM", label: "Entrance Exam (UG/PG admission)" },
    { value: "BOARD_EXAM", label: "Board Exam (Class 10/12)" },
    { value: "RECRUITMENT_EXAM", label: "Recruitment Exam (govt job hiring)" },
    { value: "ELIGIBILITY_TEST", label: "Eligibility Test (like TET, NET, SET)" },
    { value: "SCHOLARSHIP_EXAM", label: "Scholarship Exam" },
    { value: "OLYMPIAD", label: "Olympiad" },
    { value: "CERTIFICATION_EXAM", label: "Certification Exam (CA, CS, CFA)" },
    { value: "MERIT_BASED_EXAM", label: "Merit-based Exam (no exam, marks-based)" },
    { value: "ENTRANCE_CUM_SCHOLARSHIP", label: "Entrance-cum-Scholarship" },
    { value: "COMMON_NATIONAL_LEVEL_EXAM", label: "Common/National Level Exam (JEE, NEET, CUET)" },
    { value: "STATE_LEVEL_EXAM", label: "State-Level Exam" },
    { value: "INTERNATIONAL_EXAM", label: "International Exam (GRE, GMAT, IELTS, TOEFL)" },
];

export const MONTH_OPTIONS = [
    { value: 1, label: "January" },
    { value: 2, label: "February" },
    { value: 3, label: "March" },
    { value: 4, label: "April" },
    { value: 5, label: "May" },
    { value: 6, label: "June" },
    { value: 7, label: "July" },
    { value: 8, label: "August" },
    { value: 9, label: "September" },
    { value: 10, label: "October" },
    { value: 11, label: "November" },
    { value: 12, label: "December" },
];

export const APPLICATION_STATUS_OPTIONS = [
    { value: "OPEN_NOW", label: "Open now" },
    { value: "UPCOMING", label: "Upcoming" },
    { value: "CLOSED", label: "Closed" },
];
