ALTER TABLE staff ADD COLUMN advisor_year INTEGER;
ALTER TABLE staff ADD COLUMN advisor_section TEXT;

UPDATE staff
SET advisor_year = 3,
    advisor_section = 'A'
WHERE email = 'priya@kiot.ac.in';

UPDATE staff
SET advisor_year = 3,
    advisor_section = 'B'
WHERE email = 'arthipriyadharshini@kiot.ac.in';

UPDATE staff
SET advisor_year = 2,
    advisor_section = 'A'
WHERE email = 'valarmathi@kiot.ac.in';

UPDATE staff
SET advisor_year = 2,
    advisor_section = 'B'
WHERE email = 'manikandan@kiot.ac.in';