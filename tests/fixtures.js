// Realistic API fixtures (shapes taken from the live APIs on 2026-11-18)
const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
const isoNoZ = (daysAgo) => iso(daysAgo).replace(/\.\d+Z$/, '');
const sec = (daysAgo) => Math.floor((now - daysAgo * 86400000) / 1000);

exports.remotive = {
  'job-count': 3,
  jobs: [
    { id: 1001, url: 'https://remotive.com/remote-jobs/software-dev/senior-react-developer-1001', title: 'Senior React Developer', company_name: 'Acme Cloud',
      company_logo: '', category: 'Software Development', tags: ['react', 'typescript', 'node'], job_type: 'full_time', publication_date: isoNoZ(1),
      candidate_required_location: 'Worldwide', salary: '$90k - $120k', description: '<p>We need a <b>React</b> + TypeScript engineer. 5+ years. Node.js a plus.</p><script>alert(1)</script>' },
    { id: 1002, url: 'https://remotive.com/remote-jobs/software-dev/frontend-engineer-1002', title: 'Frontend Engineer (Hybrid, Berlin)', company_name: 'Berlin GmbH',
      company_logo: '', category: 'Software Development', tags: ['vue'], job_type: 'full_time', publication_date: isoNoZ(2),
      candidate_required_location: 'Germany', salary: '', description: '<p>Hybrid role.</p>' },
    { id: 1003, url: 'https://remotive.com/remote-jobs/software-dev/old-1003', title: 'React Native Developer', company_name: 'OldCo',
      company_logo: '', category: 'Software Development', tags: ['react native'], job_type: 'contract', publication_date: isoNoZ(60),
      candidate_required_location: 'USA', salary: '', description: '<p>Old post</p>' }
  ]
};

exports.jobicy = {
  apiVersion: '2.2.19', jobCount: 2, success: true,
  jobs: [
    { id: 156953, url: 'https://jobicy.com/jobs/156953-react-engineer', jobSlug: '156953-react-engineer', jobTitle: 'React Engineer', companyName: 'AlertMedia',
      companyLogo: 'https://jobicy.com/logo.jpeg', jobIndustry: ['Programming'], jobType: ['Full-Time'], jobGeo: 'APAC', jobLevel: 'Senior',
      jobExcerpt: 'Build UIs', jobDescription: '<p>React, TypeScript, GraphQL</p>', pubDate: iso(0.5), salaryMin: 70000, salaryMax: 95000, salaryCurrency: 'USD', salaryPeriod: 'yearly' },
    { id: 156954, url: 'https://jobicy.com/jobs/156954-senior-react-developer', jobTitle: 'Senior React Developer', companyName: 'Acme Cloud',
      companyLogo: '', jobIndustry: ['Programming'], jobType: ['Full-Time'], jobGeo: 'Anywhere', jobLevel: 'Senior',
      jobExcerpt: 'dup', jobDescription: '<p>duplicate of remotive</p>', pubDate: iso(1.2) }
  ]
};

exports.himalayas = {
  comments: 'x', offset: 0, limit: 20, totalCount: 2,
  jobs: [
    { title: 'Full Stack Developer (React/Node)', excerpt: 'x', companyName: 'Quicklizard', companySlug: 'quicklizard', companyLogo: '', employmentType: 'Full Time',
      minSalary: null, maxSalary: null, salaryPeriod: 'annual', seniority: ['Mid-level'], currency: null, locationRestrictions: ['United States', 'Canada'],
      timezoneRestrictions: [-5], categories: ['Full-Stack-Developer'], parentCategories: ['Developer'], description: '<p>React Node AWS</p>',
      pubDate: sec(3), expiryDate: sec(-30), applicationLink: 'https://himalayas.app/companies/quicklizard/jobs/fs?utm_source=api', guid: 'https://himalayas.app/companies/quicklizard/jobs/fs' },
    { title: 'Product Designer', excerpt: 'x', companyName: 'DesignCo', companyLogo: '', employmentType: 'Full Time', seniority: ['Senior'],
      locationRestrictions: [], categories: ['Product-Designer'], parentCategories: ['Design'], description: '<p>Figma</p>',
      pubDate: sec(2), applicationLink: 'https://himalayas.app/companies/designco/jobs/pd', guid: 'https://himalayas.app/companies/designco/jobs/pd' }
  ]
};

exports.remoteok = [
  { last_updated: sec(0), legal: 'API Terms of Service: link back to Remote OK' },
  { slug: 'remote-react-dev-doit-1', id: '1137795', epoch: sec(4), date: iso(4), company: 'DoiT', company_logo: '', position: 'React Developer',
    tags: ['react', 'javascript', 'dev'], description: 'React dev wanted', location: 'Worldwide', apply_url: 'https://remoteOK.com/remote-jobs/remote-react-dev-doit-1',
    salary_min: 60000, salary_max: 80000, logo: '', url: 'https://remoteOK.com/remote-jobs/remote-react-dev-doit-1' },
  { slug: 'remote-account-manager', id: '1137796', epoch: sec(1), company: 'SalesCo', position: 'Scaled Account Manager EMEA', tags: ['sales'],
    description: 'Sales', location: 'Estonia', apply_url: 'https://remoteOK.com/x', url: 'https://remoteOK.com/x', salary_min: 0, salary_max: 0 }
];

exports.wwr = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>WWR</title>
<item><title>Globex: Senior Frontend Developer (React)</title><region>Anywhere in the World</region><category>Front-End Programming</category><type>Full-Time</type>
<description>&lt;p&gt;React and TypeScript&lt;/p&gt;</description><pubDate>${new Date(now - 2 * 86400000).toUTCString()}</pubDate><link>https://weworkremotely.com/remote-jobs/globex-senior-frontend</link><guid>https://weworkremotely.com/remote-jobs/globex-senior-frontend</guid></item>
<item><title>Initech: Customer Support Rep</title><region>USA Only</region><category>Customer Support</category>
<description>support</description><pubDate>${new Date(now - 1 * 86400000).toUTCString()}</pubDate><link>https://weworkremotely.com/remote-jobs/initech-support</link></item>
</channel></rss>`;

exports.arbeitnow = {
  data: [
    { slug: 'react-dev-remote-1', company_name: 'Remote AG', title: 'React Developer (m/w/d)', description: '<p>React</p>', remote: true,
      url: 'https://www.arbeitnow.com/jobs/companies/remote-ag/react-dev-remote-1', tags: ['React'], job_types: ['Full time'], location: 'Berlin', created_at: sec(2) },
    { slug: 'onsite-1', company_name: 'Onsite AG', title: 'React Developer', description: '<p>React</p>', remote: false,
      url: 'https://www.arbeitnow.com/x', tags: [], job_types: [], location: 'Munich', created_at: sec(1) }
  ]
};

exports.cvText = `Priya Sharma
Senior Frontend Engineer
Bengaluru, India | priya.sharma@example.com | +91 98765 43210
linkedin.com/in/priyasharma | github.com/priyas

SUMMARY
Frontend engineer with 7 years of experience building React and TypeScript apps.

EXPERIENCE
Senior Frontend Engineer, Flipkart — Jan 2021 – Present
- Led migration of checkout to React 18 and TypeScript, cutting load time 35%
Frontend Developer, Infosys — Jun 2017 – Dec 2020
- Built dashboards with Angular and D3

SKILLS
React, TypeScript, JavaScript, Next.js, Node.js, GraphQL, Redux, Jest, Cypress, AWS, Docker, CSS, HTML, Figma

EDUCATION
B.Tech in Computer Science, VIT University, 2013 – 2017
`;

exports.aiProfile = {
  fullName: 'Priya Sharma', firstName: 'Priya', lastName: 'Sharma', email: 'priya.sharma@example.com', phone: '+91 98765 43210',
  city: 'Bengaluru', state: 'Karnataka', country: 'India', location: 'Bengaluru, India',
  linkedin: 'https://linkedin.com/in/priyasharma', github: 'https://github.com/priyas', website: '', portfolio: '',
  headline: 'Senior Frontend Engineer — React & TypeScript', summary: 'I build fast React apps.',
  currentTitle: 'Senior Frontend Engineer', currentCompany: 'Flipkart', yearsExperience: 7, seniority: 'senior',
  skills: ['React', 'TypeScript', 'JavaScript', 'Next.js', 'Node.js', 'GraphQL', 'Redux', 'Jest', 'Cypress', 'AWS', 'Docker'],
  tools: ['Figma'], softSkills: ['Mentoring'], languages: [{ language: 'English', level: 'Fluent' }, { language: 'Hindi', level: 'Native' }],
  experience: [{ title: 'Senior Frontend Engineer', company: 'Flipkart', location: 'Bengaluru', start: 'Jan 2021', end: 'Present', highlights: ['Led React 18 migration'] },
    { title: 'Frontend Developer', company: 'Infosys', start: 'Jun 2017', end: 'Dec 2020', highlights: ['Angular dashboards'] }],
  education: [{ degree: 'B.Tech', field: 'Computer Science', school: 'VIT University', start: '2013', end: '2017', grade: '' }],
  certifications: [], achievements: ['Cut checkout load time 35%'], targetRoles: ['Senior Frontend Engineer', 'React Developer', 'Full Stack Developer'],
  searchKeywords: ['react developer', 'frontend engineer', 'typescript'], industries: ['E-commerce'],
  strengths: ['7 years React'], improvementTips: ['Add metrics to Infosys role']
};
