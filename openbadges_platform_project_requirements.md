# Open Source OpenBadge 3.0 Issuer Platform

## Working title

**CredForge**

## Project summary

CredForge is an open source, self-hosted platform for issuing and managing **Open Badges 3.0** digital badges and certificates. It is intended to serve as a free alternative to commercial platforms such as Badgr and Certo for organizations that want to create, issue, verify, and manage standards-based digital credentials without paying ongoing subscription fees.

The platform should make it easy for schools, nonprofits, training providers, employers, event organizers, and community programs to issue portable and verifiable credentials at scale while retaining control over their own data, branding, infrastructure, and costs.

The system should prioritize:

- **Standards compliance** with Open Badges 3.0
- **Interoperability** with the broader digital credentials ecosystem
- **Self-hosting** for full issuer ownership and privacy
- **Ease of use** for non-technical issuers
- **Open source transparency** and extensibility
- **Low operational cost** for small organizations and community programs

## Motivation

Many existing badge issuance platforms are convenient, but they often require recurring subscription fees, limit branding or export capabilities, or lock issuers into hosted ecosystems. That creates friction for smaller organizations, nonprofits, educators, conference organizers, and community-driven initiatives that need to issue credentials affordably and sustainably.

This project exists to provide a practical, community-friendly alternative:

- No required subscription to issue standards-based credentials
- Full control over issuer infrastructure and branding
- Open source codebase that organizations can audit and extend
- Support for both badges and certificate-style credentials
- A modern issuer experience comparable to commercial tools

## Standards and ecosystem alignment

The platform must be designed around **1EdTech Open Badges 3.0**, which aligns Open Badges with the **W3C Verifiable Credentials Data Model 2.0**. In Open Badges 3.0, badge assertions are modeled as verifiable credentials, improving portability, privacy, and cryptographic verification. The 1EdTech implementation guide also describes issuer, host, and displayer roles, and notes that Open Badges 3.0 is not backward-compatible with all legacy 2.x data model requirements. citeturn0search0turn0search2turn0search10

The project should therefore be architected to:

- Issue Open Badges 3.0-compliant credentials
- Support verifiable credential concepts and proof mechanisms
- Preserve portability for recipients
- Provide human-friendly hosted views and machine-readable representations
- Leave room for optional compatibility layers or migration tooling for legacy Open Badges 2.x environments

## Product vision

Build a platform that allows an organization to:

1. Create an issuer profile
2. Design badge and certificate templates
3. Define achievement metadata and issuance criteria
4. Issue credentials individually or in bulk
5. Deliver credentials to recipients by email or claim link
6. Host public verification pages
7. Allow recipients to view, download, and share credentials
8. Manage revocation, reissuance, and audit history
9. Operate the full system on their own infrastructure

## Primary users

### Issuers
Organizations and administrators who create and issue badges/certificates.

Examples:
- Nonprofits
- CTF and competition organizers
- Schools and universities
- Internal corporate training teams
- Professional associations
- Bootcamps and training providers
- Community education programs

### Recipients
Individuals who earn credentials and need to view, verify, and share them.

### Verifiers
Employers, schools, partners, or third parties who need to validate that a credential is authentic and has not been revoked.

## Core use cases

### Issuer use cases
- Create and manage one or more issuer organizations
- Define badge classes / achievements
- Upload images, logos, and certificate artwork
- Configure criteria, skills, tags, and evidence requirements
- Issue one credential to one recipient
- Bulk issue many credentials using CSV or API
- Reissue credentials when metadata changes
- Revoke credentials when necessary
- Manage teams, roles, and permissions
- Export records for compliance and reporting

### Recipient use cases
- Receive a credential by email or secure claim link
- View a hosted credential page
- Download machine-readable credential data
- Download or view a certificate-style representation
- Share a public verification link
- Maintain a simple credential wallet/profile within the platform

### Verifier use cases
- Visit a public verification page
- Confirm issuer identity, credential status, recipient name, issue date, and achievement metadata
- Determine whether the credential is valid, revoked, or expired
- Inspect proof and verification details where appropriate

## Functional requirements

## 1. Multi-tenant issuer management
- Support multiple organizations on one installation
- Allow each organization to manage:
  - issuer profile
  - logo and branding
  - public issuer page
  - website/contact metadata
  - signing and verification configuration
- Support sub-organizations or departments as an optional future feature

## 2. Authentication and access control
- Local authentication with secure password handling
- Optional SSO support in later phases (OIDC/SAML)
- Role-based access control
- Suggested roles:
  - Platform Admin
  - Organization Admin
  - Issuer Manager
  - Template Designer
  - Viewer / Auditor
- Optional MFA support

## 3. Issuer profiles
Each issuer should be able to define:
- legal/public organization name
- issuer identifier
- website URL
- description
- logo/image
- contact email
- social links
- public verification page
- signing keys or VC proof settings

## 4. Achievement and template management
The platform should support creation of:
- badge templates
- certificate templates
- achievement definitions
- skill/competency metadata
- criteria text and URLs
- evidence fields
- tags and categories
- expiration settings, where applicable
- alignment to external standards or frameworks

Template features should include:
- badge image upload
- certificate background upload
- visual preview
- branded styling
- dynamic fields such as recipient name, issue date, credential ID, and achievement title

## 5. Credential issuance
The platform must support:
- single issuance through the UI
- bulk issuance via CSV upload
- issuance through REST API
- draft/pending issuance workflows
- scheduled issuance as a future enhancement
- credential regeneration or reissuance
- support for both badges and certificates as presentation formats backed by standards-based credential data

Recipient fields may include:
- full name
- email address
- recipient identifier
- issued date
- optional expiration date
- evidence URL(s)
- custom metadata fields

## 6. Delivery and claiming
- Email delivery with customizable templates
- Secure claim link workflow
- Public hosted credential page
- Optional account-less claiming for simple distribution
- Optional recipient account creation for credential management

## 7. Verification and public display
The platform should provide:
- public verification URLs
- machine-readable credential representation
- human-friendly credential page
- clear status display: valid, revoked, expired, pending
- issuer profile linkage
- evidence and criteria display where allowed

## 8. Revocation and lifecycle management
- Revoke credentials individually or in bulk
- Provide revocation reason fields
- Maintain immutable issuance history where appropriate
- Allow replacement/reissuance workflows
- Track changes with audit logs

## 9. Search, filtering, and reporting
Issuers should be able to:
- search credentials by recipient, template, date, or status
- filter by organization, achievement, or campaign
- export credential data as CSV/JSON
- view issuance metrics dashboards
- track delivery status and claim status

## 10. API and integrations
The platform should expose APIs for:
- issuer management
- template management
- credential issuance
- credential lookup and status
- verification workflows
- webhook/event delivery

Potential integrations:
- LMS platforms
- event registration systems
- HR/L&D systems
- CRM platforms
- email delivery services
- identity providers

## 11. Branding and white-labeling
Each issuer organization should be able to customize:
- logos
- colors
- email templates
- public credential pages
- issuer landing page
- certificate appearance

## 12. Import/export and portability
- Export issued credential data in standards-compliant form
- Export issuer and template metadata
- Import legacy issuance data where feasible
- Optional migration tooling for Open Badges 2.x sources

## Non-functional requirements

## 1. Open source
- License should be permissive or community-friendly
- Strong candidates: Apache-2.0 or MIT
- Public repository with contribution guidelines
- Clear documentation for setup, development, and deployment

## 2. Self-hosted deployment
The platform should be easy to deploy using:
- Docker Compose for simple installs
- Kubernetes manifests or Helm charts as an advanced option
- Reverse proxy support (Nginx, Traefik, Caddy)
- External database and object storage support

Minimum deployment goals:
- one-command local developer startup
- straightforward production deployment guide
- environment-variable based configuration

## 3. Security
The application should follow strong security practices:
- HTTPS required in production
- secure secret and key management
- encryption of sensitive configuration where needed
- RBAC enforcement
- audit logging
- CSRF protection
- input validation and output encoding
- rate limiting
- secure session handling
- signed credential integrity checks
- dependency and container scanning in CI

Because this is a credentialing platform, special attention should be paid to:
- issuer key custody
- credential tampering resistance
- replay/forgery prevention
- verification reliability
- privacy controls around recipient data

## 4. Scalability
- Capable of small single-org deployments and larger multi-org installations
- Background job processing for email, bulk issuance, and document generation
- Efficient database indexing for issuance and search
- Object storage support for media assets and certificate files

## 5. Reliability and observability
- Structured logs
- Health check endpoints
- Metrics and monitoring hooks
- Backup and restore guidance
- Job retry behavior
- Administrative diagnostics view

## 6. Usability
- Clean admin UI
- Fast and simple issuance workflows
- Accessible design where possible
- Good defaults for non-technical users
- Inline guidance and validation

## Technical architecture requirements

## Suggested architecture
A modular architecture is recommended:

### Frontend
- Web admin dashboard
- Public credential verification pages
- Recipient credential viewer

### Backend services
- authentication/authorization
- issuer management
- template management
- credential issuance engine
- proof/signing service
- verification service
- notification service
- reporting/export service

### Data/storage
- relational database for core entities
- object storage for images, certificate assets, exports
- queue/backing service for async jobs

## Suggested core entities
- User
- Organization
- IssuerProfile
- Role
- AchievementTemplate
- BadgeTemplate
- CertificateTemplate
- Credential
- Recipient
- Evidence
- RevocationRecord
- AuditLog
- APIKey
- EmailTemplate

## Recommended technology direction
This can be adapted, but a strong initial stack could be:

- **Frontend:** React / Next.js
- **Backend:** Python (Django/FastAPI) or Node.js (NestJS)
- **Database:** PostgreSQL
- **Queue/Jobs:** Redis + worker
- **Storage:** S3-compatible object storage
- **Deployment:** Docker Compose first, Kubernetes later

## Credential and certificate model requirements

The system should distinguish between:

### Credential data model
The standards-based digital credential containing issuer, recipient, achievement, dates, status, proof, and verification data.

### Presentation layer
Human-friendly presentation of that credential as:
- a badge page
- a certificate page
- downloadable JSON or VC representation
- optional printable PDF certificate

This separation is important because the certificate is primarily a presentation artifact, while the verifiable credential is the authoritative standards-based record.

## Minimum viable product (MVP)

### MVP goals
The first release should support:
- self-hosted deployment
- organization/issuer setup
- badge template creation
- certificate template creation
- individual issuance
- bulk issuance by CSV
- public hosted verification page
- email delivery
- revocation
- audit logging
- basic REST API
- Open Badges 3.0-compliant credential generation

### MVP exclusions
These can be deferred:
- advanced SSO
- marketplace/discovery features
- deep LMS integrations
- mobile apps
- blockchain-specific features
- advanced analytics
- recipient wallet federation
- extensive legacy migration tooling

## Future roadmap ideas

### Phase 2
- webhook support
- more advanced API coverage
- issuer analytics dashboards
- team collaboration improvements
- white-label domain mapping
- advanced search and exports

### Phase 3
- LMS and HRIS integrations
- recipient wallet features
- endorsement workflows
- pathway/stackable credential support
- alignment with complementary CLR-style workflows
- conformance testing automation

### Phase 4
- optional managed hosting offering
- federation/discovery features
- plugin marketplace
- multilingual localization support

## Admin UI requirements

The web interface should include:

### Dashboard
- issuance counts
- recent activity
- template summary
- pending/revoked counts

### Issuer settings
- organization profile
- branding
- verification settings
- email settings
- API keys

### Templates
- badge templates list
- certificate templates list
- create/edit/preview workflows

### Credentials
- issue credential
- bulk issue wizard
- search/filter list
- detail page
- revoke/reissue actions

### Reporting
- exports
- audit logs
- delivery status

## Recipient experience requirements

Recipients should be able to:
- receive a clean email notification
- claim or view their credential from a secure link
- access a branded public page
- view credential metadata and evidence
- share a verification link
- download certificate-style presentation where enabled

## Verification requirements

Verification pages should make it easy to answer:
- Who issued this credential?
- To whom was it issued?
- What was earned?
- When was it issued?
- Is it still valid?
- Has it been revoked or expired?
- Can the credential data and proof be validated?

## Data privacy requirements

The platform should minimize unnecessary exposure of recipient data and provide configuration for:
- public vs private credential visibility
- field-level display controls
- retention policies
- consent and claim workflows where needed
- deletion/anonymization workflows subject to credential integrity considerations

## Developer and community requirements

To succeed as an open source project, it should include:
- clear README
- architecture overview
- contribution guide
- code of conduct
- sample data and demo environment
- API documentation
- issue templates
- roadmap/project board
- automated tests and CI pipeline

## Acceptance criteria for initial release

The initial release should be considered successful if an organization can:

1. Deploy the platform on its own server
2. Create an issuer profile and branded templates
3. Issue a badge or certificate to one or more recipients
4. Deliver those credentials through email or claim links
5. Let third parties verify credential authenticity through public URLs
6. Revoke a credential and have the status reflected publicly
7. Export issuance records and retain audit history

## Risks and design considerations

- Open Badges 3.0 implementation complexity may be higher than legacy badge formats
- VC proof and verification choices should be flexible enough to evolve
- Legacy ecosystem compatibility may require optional support for older badge consumers
- Certificate presentation features must not undermine the integrity of the underlying credential
- Multi-tenant security boundaries must be strong
- Email deliverability and claim security must be treated as first-class concerns

## Success metrics

Possible metrics for project success:
- time to first issuance after deployment
- number of active issuer organizations
- number of credentials issued
- successful verification rate
- average issuance time for bulk campaigns
- number of community contributors
- number of deployments by nonprofits, schools, and community projects

## Suggested repository structure

```text
/docs
/apps/web
/apps/api
/packages/ui
/packages/credential-engine
/packages/verification
/packages/common
/deploy/docker-compose
/deploy/k8s
/scripts
```

## Summary

CredForge should be a practical, standards-aligned, open source credential issuance platform that gives organizations the ability to issue Open Badges 3.0 digital badges and certificate-style credentials without subscription lock-in. The product should combine strong standards compliance, straightforward self-hosting, modern UX, and extensibility so that smaller issuers can participate in the digital credential ecosystem on equal footing with commercial platforms.
