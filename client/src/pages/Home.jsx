import { useNavigate } from "react-router-dom";
import "./Home.css";

const EXAM_STRIP = [
    "JEE MAIN",
    "NEET",
    "CUET",
    "CLAT",
    "CAT",
    "UPSC CSE",
    "GATE",
    "NDA",
    "CDS",
    "BITSAT",
    "XAT",
    "VITEEE",
    "SSC CGL",
    "IBPS PO",
];

const MATCHED_EXAMS = ["JEE MAIN", "JEE ADVANCED", "BITSAT", "CUET", "VITEEE", "COMEDK"];

const STATS = [
    { num: "40+", label: "National entrance exams tracked" },
    { num: "2 min", label: "To get your personalized match list" },
    { num: "0", label: "Missed deadlines, with timely reminders" },
];

const STEPS = [
    {
        num: "01",
        title: "Tell us about your profile",
        text: "Class, stream, board, marks and category — the same details every exam form asks for anyway.",
    },
    {
        num: "02",
        title: "We check the fine print",
        text: "We run your details against the eligibility rules of every major national exam, updated each admission cycle.",
    },
    {
        num: "03",
        title: "Get your matched list",
        text: "A clean list of exams you qualify for, with deadlines — so you know exactly where to spend your prep time.",
    },
];

function Home() {
    const navigate = useNavigate();
    const stripItems = [...EXAM_STRIP, ...EXAM_STRIP];

    return (
        <div className="home-page">
            <nav className="home-nav">
                <div className="home-nav__inner">
                    <div className="home-brand">
                        <span className="home-brand-mark">N</span>
                        NextStep
                    </div>
                    <button
                        type="button"
                        className="home-nav-login"
                        onClick={() => navigate("/login")}
                    >
                        Login →
                    </button>
                </div>
            </nav>

            <section className="home-hero">
                <div className="home-hero__copy">
                    <div className="home-eyebrow">Eligibility check</div>
                    <h1 className="home-hero__title">
                        Find every exam
                        <br />
                        you&apos;re <em>actually</em>
                        <br />
                        eligible for.
                    </h1>
                    <p className="home-sub">
                        Answer a few questions about your class, stream and marks. We&apos;ll match
                        your profile against 40+ national entrance exams — no guesswork, no missed
                        deadlines.
                    </p>
                    <div className="home-cta-row">
                        <button
                            type="button"
                            className="home-btn home-btn--primary"
                            onClick={() => navigate("/signup")}
                        >
                            Get started
                        </button>
                        <button
                            type="button"
                            className="home-btn home-btn--secondary"
                            onClick={() => navigate("/login")}
                        >
                            Login
                        </button>
                    </div>
                    <div className="home-trust">
                        Trusted by students prepping for JEE, NEET, CUET &amp; CLAT
                    </div>
                </div>

                <div className="home-card-stage">
                    <div className="home-admit-card">
                        <div className="home-card-top">
                            <div>
                                <div className="home-card-label">Eligibility slip</div>
                                <div className="home-card-title">Your Exam Match</div>
                            </div>
                            <span className="home-verified-pill">✓ Verified</span>
                        </div>

                        <div className="home-card-body">
                            <div className="home-photo-box" aria-hidden="true">A</div>
                            <div className="home-fields">
                                <div className="home-field">
                                    <label>Class / Stream</label>
                                    <div className="home-field__val">12th · Science (PCM)</div>
                                </div>
                                <div className="home-field">
                                    <label>State Board</label>
                                    <div className="home-field__val">CBSE</div>
                                </div>
                            </div>
                        </div>

                        <div className="home-card-matches">
                            <div className="home-matches-label">Matched exams (6)</div>
                            <div className="home-chip-row">
                                {MATCHED_EXAMS.map((exam) => (
                                    <span key={exam} className="home-chip">
                                        {exam}
                                    </span>
                                ))}
                            </div>
                        </div>

                        <div className="home-card-foot">
                            <span>
                                <strong>3 applications</strong> open now
                            </span>
                            <span aria-hidden="true">→</span>
                        </div>
                    </div>
                </div>
            </section>

            <div className="home-strip-wrap">
                <div className="home-strip" aria-hidden="true">
                    {stripItems.map((exam, index) => (
                        <span key={`${exam}-${index}`}>{exam}</span>
                    ))}
                </div>
            </div>

            <section className="home-how">
                <div className="home-how-head">
                    <div className="home-eyebrow">How it works</div>
                    <h2>Three steps. Two minutes.</h2>
                    <p>
                        No lengthy sign-up forms, no PDFs to dig through. Just tell us who you are,
                        and we&apos;ll tell you what you can apply for.
                    </p>
                </div>
                <div className="home-steps">
                    {STEPS.map((step) => (
                        <div key={step.num} className="home-step">
                            <div className="home-step-num">{step.num}</div>
                            <h3>{step.title}</h3>
                            <p>{step.text}</p>
                        </div>
                    ))}
                </div>
            </section>

            <section className="home-stats" aria-label="Why NextStep">
                {STATS.map((stat) => (
                    <div key={stat.label} className="home-stat">
                        <div className="home-stat__num">{stat.num}</div>
                        <div className="home-stat__label">{stat.label}</div>
                    </div>
                ))}
            </section>

            <section className="home-footer-cta">
                <div className="home-fc-inner">
                    <div>
                        <h3>Stop guessing which exams to prep for.</h3>
                        <p>Get your personalized eligibility list in under two minutes.</p>
                    </div>
                    <button
                        type="button"
                        className="home-btn home-btn--light"
                        onClick={() => navigate("/signup")}
                    >
                        Check my eligibility
                    </button>
                </div>
            </section>

            <footer className="home-footer">
                <div className="home-footer__inner">
                    <span>© 2026 NextStep</span>
                    <span>Made for students navigating India&apos;s exam maze</span>
                </div>
            </footer>
        </div>
    );
}

export default Home;
